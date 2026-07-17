/**
 * Voice companion: the brain of hands-free interaction.
 *
 * Layered over the existing chat/run/confirmation flow — no new agent loop.
 * While voice is enabled, a continuous VAD-gated session listens (Phase B of
 * the hands-free spec): the mic stays open, local VAD detects speech, every
 * detected segment is transcribed, and the current parser context decides what
 * acts. Unaddressed ambient speech is discarded — never persisted or logged.
 *
 * Contexts: in the *open* context (the session default) speech acts only when
 * it starts with the addressing phrase ("Pipali, …"). An *engaged* exchange —
 * bare speech privileged — exists only after the user addresses Pipali or taps:
 * announcements (confirmation/completion cues) wait silently until acknowledged
 * with "Pipali, go ahead" or a tap; after Pipali speaks, a short reply
 * invitation accepts a bare reply, then lapses back to open.
 *
 * The voice mode sets speaking etiquette: `ask_first` gates announcements on
 * the go-ahead as above; `speak_freely` reads each announcement once, at the
 * earliest moment the channel is free — standing consent for solo multi-tasking.
 * Modes switch at any moment, decoupled from companion state: spoken ("Pipali,
 * speak freely" / "ask first" / "stop listening") in every parser context, or via UI.
 *
 * Turns use the segmented model (Phase A): pauses close STT segments, never
 * the turn; a live transcript accumulates; turns end on a tail phrase or tap.
 * Reply turns short-circuit on decisive intents ("yes" resolves immediately).
 * Free-form replies like confirmation guidance, follow-ups are sent directly.
 *
 * Safety/limits: half-duplex (capture suppressed only while Pipali speaks),
 * an idle timeout that ends the session after prolonged unaddressed silence,
 * announcement dedup across reconnect replays, and an active-conversation gate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationRequest } from '../../server/processor/confirmation/confirmation.types';
import { CONFIRMATION_OPTIONS } from '../../server/processor/confirmation/confirmation.types';
import { isVoiceCaptureSupported, transcribeAudio, synthesizeSpeech, summarizeForSpeech } from '../utils/voice-audio';
import { SegmentedCapture } from '../utils/voice-capture';
import { TurnTranscript, isHallucination } from '../utils/voice-turn';
import { VOICE_TUNABLES, STT_BIAS_PROMPT, type VoiceMode } from '../utils/voice-config';
import { playVoiceCue, playTranscriptTicks, speakAudio, stopSpeaking, voiceCueDurationMs, type VoiceCueProfile } from '../utils/notifications';
import { parseConfirmationIntent, parseGoAhead, parseAddressing } from '../utils/voice-intent';
import { buildConfirmationSummary, buildCompletionSummary } from '../utils/voice-summary';

export type VoiceStatus = 'idle' | 'dormant' | 'announced' | 'speaking' | 'listening' | 'transcribing';

interface PendingConfirmation {
    kind: 'confirmation';
    key: string;
    conversationId: string;
    runId: string;
    request: ConfirmationRequest;
    summary: string;
    /** Synthesis finished and the announce cue played; gates speak_freely auto-play. */
    ready: boolean;
    /** Readout attempted at least once; speak_freely auto-plays only unheard pendings. */
    heard: boolean;
}
interface PendingCompletion {
    kind: 'completion';
    key: string;
    conversationId: string;
    summary: string;
    /** The full response text, rephrased into spoken style at prefetch time. */
    raw: string;
    ready: boolean;
    heard: boolean;
}
type Pending = PendingConfirmation | PendingCompletion;

type TurnKind = 'reply' | 'composed';

interface ActiveTurn {
    kind: TurnKind;
    transcript: TurnTranscript;
    /** Capture sequence of the turn's first segment; null until one arrives. */
    baseSeq: number | null;
    inFlight: number;
    finishing: boolean;
}

export interface UseVoiceCompanionParams {
    mode: VoiceMode;
    activeConversationId: string | undefined;
    sendMessage: (text: string, conversationId?: string) => void;
    respondToConfirmation: (conversationId: string, runId: string, requestId: string, optionId: string, guidance?: string) => void;
    onError?: (message: string) => void;
    /** Persist a mode change (spoken switches route through here too). */
    onModeChange?: (mode: VoiceMode) => void;
}

function resolveOptionIds(req: ConfirmationRequest) {
    const opts = req.options || [];
    const primary = opts.find((o) => o.id === CONFIRMATION_OPTIONS.YES)
        ?? opts.find((o) => o.style === 'primary') ?? opts[0];
    const decline = opts.find((o) => o.id === CONFIRMATION_OPTIONS.NO)
        ?? opts.find((o) => o.style === 'danger');
    const dontAsk = opts.find((o) => o.id === CONFIRMATION_OPTIONS.YES_DONT_ASK)
        ?? opts.find((o) => o.persistPreference);
    return { primary, decline, dontAsk };
}

/** Intents decisive enough to resolve a reply turn without an end phrase. */
function isReplyShortCircuit(intentType: string, pendingKind: 'confirmation' | 'completion'): boolean {
    if (intentType === 'guidance') return false;
    if (pendingKind === 'completion') return ['repeat', 'details', 'stop_listening', 'set_mode'].includes(intentType);
    return true;
}

export function useVoiceCompanion(params: UseVoiceCompanionParams) {
    const { mode, activeConversationId } = params;
    const [status, setStatus] = useState<VoiceStatus>('idle');
    const [liveTranscript, setLiveTranscript] = useState('');

    const supported = isVoiceCaptureSupported();

    // Refs so the imperative event handlers always see current values.
    const cbRef = useRef(params);
    useEffect(() => { cbRef.current = params; }, [params]);
    const activeConvRef = useRef(activeConversationId);
    useEffect(() => { activeConvRef.current = activeConversationId; }, [activeConversationId]);

    const pendingRef = useRef<Pending | null>(null);
    const prefetchRef = useRef<Map<string, Promise<ArrayBuffer>>>(new Map());
    const spokenKeysRef = useRef<Set<string>>(new Set());
    const turnRef = useRef<ActiveTurn | null>(null);
    const captureRef = useRef<SegmentedCapture | null>(null);
    const sessionTokenRef = useRef(0);
    const inviteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressCountRef = useRef(0);
    const busyRef = useRef(false);
    // Late-bound functions, breaking cycles like segment → route → speak → listen → segment.
    const routeRef = useRef<(kind: TurnKind, text: string) => void>(() => {});
    const handleSegmentRef = useRef<(wav: Blob, seq: number) => void>(() => {});
    const goDormantRef = useRef<() => void>(() => {});
    const settleRef = useRef<() => void>(() => {});

    // ------------------------------------------------------------------
    // Half-duplex: capture suppressed only while Pipali speaks (TTS) —
    // long content audio a mic would transcribe back into the conversation.
    // Feedback earcons play unsuppressed as the VAD's min-speech rejection,
    // the addressing gate, and the hallucination guard can absorb it.
    // This avoids creating deaf windows exactly when users speak — mid-turn
    // ticks clipping next phrase, work pulses eating "Pipali, stop".
    // ------------------------------------------------------------------
    const acquireSuppression = useCallback(() => {
        suppressCountRef.current++;
        captureRef.current?.setSuppressed(true);
    }, []);
    const releaseSuppression = useCallback(() => {
        suppressCountRef.current = Math.max(0, suppressCountRef.current - 1);
        if (suppressCountRef.current === 0) captureRef.current?.setSuppressed(false);
    }, []);

    const reportError = useCallback((message: string) => {
        playVoiceCue('error');
        cbRef.current.onError?.(message);
    }, []);

    // ------------------------------------------------------------------
    // Timers
    // ------------------------------------------------------------------
    const clearInviteTimer = useCallback(() => {
        if (inviteTimerRef.current) { clearTimeout(inviteTimerRef.current); inviteTimerRef.current = null; }
    }, []);
    const clearIdleTimer = useCallback(() => {
        if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    }, []);
    /** Addressed speech keeps the session alive; prolonged silence ends it. */
    const markAddressed = useCallback(() => {
        clearIdleTimer();
        idleTimerRef.current = setTimeout(() => goDormantRef.current(), VOICE_TUNABLES.idleTimeoutMs);
    }, [clearIdleTimer]);

    // ------------------------------------------------------------------
    // Turn teardown (the session capture survives turn teardown)
    // ------------------------------------------------------------------
    const releaseTurn = useCallback((turn: ActiveTurn) => {
        if (turnRef.current === turn) turnRef.current = null;
        clearInviteTimer();
        setLiveTranscript('');
    }, [clearInviteTimer]);

    const completeTurn = useCallback((turn: ActiveTurn, message: string) => {
        const kind = turn.kind;
        releaseTurn(turn);
        routeRef.current(kind, message);
    }, [releaseTurn]);

    const cancelTurn = useCallback((turn: ActiveTurn) => {
        releaseTurn(turn);
        playVoiceCue('cancel');
        settleRef.current();
    }, [releaseTurn]);

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------
    const stopSession = useCallback((withCue: boolean) => {
        sessionTokenRef.current++;
        clearInviteTimer();
        clearIdleTimer();
        // Stale suppression would start the next session deaf; late TTS releases clamp at zero.
        suppressCountRef.current = 0;
        // A pending that survives dormancy re-synthesizes from its summary on cache miss.
        prefetchRef.current.clear();
        const turn = turnRef.current;
        if (turn) releaseTurn(turn);
        const capture = captureRef.current;
        captureRef.current = null;
        capture?.stop();
        if (withCue && capture) playVoiceCue('session_end');
    }, [clearInviteTimer, clearIdleTimer, releaseTurn]);

    const startSession = useCallback(async () => {
        if (captureRef.current || !supported) return;
        const token = ++sessionTokenRef.current;
        const capture = new SegmentedCapture({
            onSegment: (wav, seq) => handleSegmentRef.current(wav, seq),
            onSpeechStart: () => {
                // Speech inside a reply turn cancels the invitation lapse.
                if (turnRef.current) clearInviteTimer();
            },
        });
        try {
            await capture.start();
        } catch (err) {
            reportError(err instanceof Error ? err.message : 'Microphone unavailable');
            setStatus('dormant');
            return;
        }
        if (sessionTokenRef.current !== token) { capture.stop(); return; }
        captureRef.current = capture;
        if (suppressCountRef.current > 0) capture.setSuppressed(true);
        playVoiceCue('session_start');
        setStatus(pendingRef.current ? 'announced' : 'idle');
        markAddressed();
    }, [supported, reportError, markAddressed, clearInviteTimer]);

    const reset = useCallback(() => {
        stopSpeaking();
        stopSession(false);
        pendingRef.current = null;
        busyRef.current = false;
        setLiveTranscript('');
        setStatus('idle');
    }, [stopSession]);

    // The session lives exactly as long as voice is on. Keyed on the boolean
    // so switching between the two on-modes never restarts capture.
    const active = mode !== 'off';
    useEffect(() => {
        if (!active || !supported) {
            reset();
            return;
        }
        void startSession();
        return () => stopSession(false);
    }, [active, supported, startSession, stopSession, reset]);

    const goDormant = useCallback(() => {
        stopSession(true);
        setStatus('dormant');
    }, [stopSession]);
    useEffect(() => { goDormantRef.current = goDormant; }, [goDormant]);

    // ------------------------------------------------------------------
    // Reply turns (engaged exchange after Pipali speaks)
    // ------------------------------------------------------------------
    const lapseReply = useCallback((turn: ActiveTurn) => {
        releaseTurn(turn);
        playVoiceCue('lapse');                       // soft blip: the reply window closed
        const pending = pendingRef.current;
        if (pending?.kind === 'completion' && pending.heard) {
            pendingRef.current = null;               // summary was heard; nothing more owed
            prefetchRef.current.delete(pending.key);
        }
        settleRef.current();
    }, [releaseTurn]);

    const openReplyTurn = useCallback(() => {
        const turn: ActiveTurn = { kind: 'reply', transcript: new TurnTranscript(), baseSeq: null, inFlight: 0, finishing: false };
        turnRef.current = turn;
        setLiveTranscript('');
        setStatus('listening');
        playVoiceCue('listening');
        clearInviteTimer();
        inviteTimerRef.current = setTimeout(() => {
            const current = turnRef.current;
            if (current === turn && !current.finishing && current.inFlight === 0 && !current.transcript.text) {
                lapseReply(turn);
            }
        }, VOICE_TUNABLES.replyInvitationMs);
    }, [clearInviteTimer, lapseReply]);

    const openComposedTurn = useCallback(() => {
        const turn: ActiveTurn = { kind: 'composed', transcript: new TurnTranscript(), baseSeq: null, inFlight: 0, finishing: false };
        turnRef.current = turn;
        setLiveTranscript('');
        setStatus('listening');
        playVoiceCue('listening');
    }, []);

    // ------------------------------------------------------------------
    // Speaking (always half-duplex, always followed by a reply invitation)
    // ------------------------------------------------------------------
    const speakThenListen = useCallback(async (getAudio: () => Promise<ArrayBuffer>) => {
        if (!captureRef.current) await startSession();
        setStatus('speaking');
        acquireSuppression();
        try {
            await speakAudio(await getAudio());
        } catch {
            // Synthesis/playback failed — fall through to listening anyway.
        } finally {
            releaseSuppression();
        }
        // A barge-in tap may already have opened the reply turn.
        if (!turnRef.current) openReplyTurn();
    }, [startSession, acquireSuppression, releaseSuppression, openReplyTurn]);

    const speakPendingAndListen = useCallback(async (pending: Pending) => {
        // Marked on attempt, not success — a failing synthesis must not loop.
        pending.heard = true;
        await speakThenListen(() => {
            const cached = prefetchRef.current.get(pending.key);
            prefetchRef.current.delete(pending.key);
            return cached ?? synthesizeSpeech(pending.summary);
        });
    }, [speakThenListen]);

    /**
     * Park at announced/idle — except speak_freely owes any unheard *ready*
     * pending a readout. Pre-ready pendings stay parked; announce's readiness
     * callback picks them up, so speech never stalls waiting on synthesis.
     */
    const settle = useCallback(() => {
        if (turnRef.current) return;    // an open turn owns the channel; it settles on its own resolution
        const pending = pendingRef.current;
        if (pending && pending.ready && !pending.heard && cbRef.current.mode === 'speak_freely' && suppressCountRef.current === 0) {
            void speakPendingAndListen(pending);
            return;
        }
        setStatus(pending ? 'announced' : 'idle');
    }, [speakPendingAndListen]);
    useEffect(() => { settleRef.current = settle; }, [settle]);

    /** Short spoken confirmation that doesn't invite a reply (unlike speakThenListen). */
    const speakAck = useCallback(async (text: string) => {
        setStatus('speaking');
        acquireSuppression();
        try {
            await speakAudio(await synthesizeSpeech(text));
        } catch {
            // best-effort; the mode switch itself already took effect
        } finally {
            releaseSuppression();
        }
        settle();
    }, [acquireSuppression, releaseSuppression, settle]);

    const applyMode = useCallback((target: Exclude<VoiceMode, 'off'>) => {
        cbRef.current.onModeChange?.(target);
        void speakAck(target === 'speak_freely'
            ? "Okay, I'll speak as soon as I have something."
            : "Okay, I'll chime first and wait for your go-ahead.");
    }, [speakAck]);

    // A UI switch to speak_freely while an announcement waits unheard reads it
    // immediately — the "okay, just tell me" gesture. Spoken switches land here
    // too, but speakAck already holds suppression then, so settle covers them.
    useEffect(() => {
        if (mode !== 'speak_freely') return;
        const pending = pendingRef.current;
        if (pending && pending.ready && !pending.heard && !turnRef.current && suppressCountRef.current === 0) {
            void speakPendingAndListen(pending);
        }
    }, [mode, speakPendingAndListen]);

    // ------------------------------------------------------------------
    // Announcements (cues are background notes; they wait to be acknowledged)
    // ------------------------------------------------------------------
    const prefetch = useCallback((pending: Pending): Promise<ArrayBuffer> => {
        const p = (async () => {
            if (pending.kind === 'completion') {
                // Rephrase into voice-conversation style; the mechanical summary
                // already in pending.summary is the fallback. Updating the pending
                // keeps "repeat"/"details" re-reads consistent with what was played.
                try {
                    const spoken = (await summarizeForSpeech(pending.raw)).trim();
                    if (spoken) pending.summary = spoken;
                } catch { /* keep the mechanical summary */ }
            }
            return synthesizeSpeech(pending.summary);
        })();
        p.catch((err) => {
            reportError(err instanceof Error ? err.message : 'Voice synthesis failed');
        });
        prefetchRef.current.set(pending.key, p);
        return p;
    }, [reportError]);

    const announce = useCallback((pending: Pending, cue: VoiceCueProfile) => {
        // Drop the superseded announcement's prefetched audio.
        const replaced = pendingRef.current;
        if (replaced && replaced.key !== pending.key) prefetchRef.current.delete(replaced.key);
        const audio = prefetch(pending);
        pendingRef.current = pending;
        // The cue marks the readout as *ready*, not the text as complete —
        // summarize + TTS take seconds, and a cue at text-completion invites a
        // go-ahead into dead air (or, in speak_freely, opens a confusing gap
        // between chime and speech). Synthesis failure surfaces via the error
        // cue in prefetch instead.
        audio.then(() => {
            if (pendingRef.current !== pending || pending.heard) return;   // superseded, reset, or already being read
            pending.ready = true;
            playVoiceCue(cue);
            // speak_freely: read it once the cue has landed — even from
            // dormant; the idle timeout bounds listening, not speaking.
            setTimeout(() => {
                if (pendingRef.current !== pending || pending.heard) return;
                if (cbRef.current.mode === 'speak_freely' && !turnRef.current && suppressCountRef.current === 0) {
                    void speakPendingAndListen(pending);
                }
            }, voiceCueDurationMs(cue));
        }, () => {});
        // Don't disturb an open turn or active speech; the pending state is
        // picked up when the current exchange settles.
        setStatus((s) => (s === 'idle' || s === 'announced' ? 'announced' : s));
    }, [prefetch, speakPendingAndListen]);

    // Bounded, never cleared: dedup must survive session cycles so reconnect
    // replays stay silent after a voice off/on.
    const markSpoken = useCallback((key: string) => {
        const keys = spokenKeysRef.current;
        keys.add(key);
        if (keys.size > 200) {
            const oldest = keys.values().next().value;
            if (oldest !== undefined) keys.delete(oldest);
        }
    }, []);

    const onConfirmationRequest = useCallback((request: ConfirmationRequest, convId: string, runId: string) => {
        if (cbRef.current.mode === 'off' || !supported) return;
        if (convId !== activeConvRef.current) return;            // active-conversation gate
        const key = `c:${request.requestId}`;
        if (spokenKeysRef.current.has(key)) return;              // dedup replays
        markSpoken(key);
        announce({ kind: 'confirmation', key, conversationId: convId, runId, request, summary: buildConfirmationSummary(request), ready: false, heard: false }, 'confirmation');
    }, [supported, announce, markSpoken]);

    const onTaskComplete = useCallback((response: string, convId: string) => {
        if (cbRef.current.mode === 'off' || !supported) return;
        if (convId !== activeConvRef.current) return;
        // No runId in the completion callback — key on content so replays dedup.
        const key = `t:${convId}:${response.length}:${response.slice(0, 32)}`;
        if (spokenKeysRef.current.has(key)) return;
        markSpoken(key);
        announce({ kind: 'completion', key, conversationId: convId, summary: buildCompletionSummary(response), raw: response, ready: false, heard: false }, 'complete');
    }, [supported, announce, markSpoken]);

    // ------------------------------------------------------------------
    // Reply routing
    // ------------------------------------------------------------------
    const handleConfirmationReply = useCallback((pending: PendingConfirmation, text: string) => {
        const isQuestion = pending.request.operation === 'ask_user';
        const intent = parseConfirmationIntent(text, { isQuestion });
        const { conversationId, runId, request } = pending;
        const { primary, decline, dontAsk } = resolveOptionIds(request);
        const respond = cbRef.current.respondToConfirmation;

        switch (intent.type) {
            case 'approve':
                if (primary) respond(conversationId, runId, request.requestId, primary.id);
                playVoiceCue('submit'); pendingRef.current = null; setStatus('idle'); break;
            case 'approve_dont_ask':
                if (dontAsk) respond(conversationId, runId, request.requestId, dontAsk.id);
                else if (primary) respond(conversationId, runId, request.requestId, primary.id);
                playVoiceCue('submit'); pendingRef.current = null; setStatus('idle'); break;
            case 'decline':
                if (decline) respond(conversationId, runId, request.requestId, decline.id);
                playVoiceCue('submit'); pendingRef.current = null; setStatus('idle'); break;
            case 'guidance':
                respond(conversationId, runId, request.requestId, CONFIRMATION_OPTIONS.GUIDANCE, intent.text);
                playVoiceCue('submit'); pendingRef.current = null; setStatus('idle'); break;
            case 'details':
            case 'repeat':
                void speakPendingAndListen(pending); break;  // re-read, then listen again
            case 'set_mode':
                applyMode(intent.mode); break;               // confirmation stays pending
            case 'stop_listening':
                cbRef.current.onModeChange?.('off'); reset(); break;
        }
    }, [speakPendingAndListen, reset, applyMode]);

    const handleCompletionReply = useCallback((pending: PendingCompletion, text: string) => {
        const intent = parseConfirmationIntent(text, { isQuestion: false });
        if (intent.type === 'stop_listening') { cbRef.current.onModeChange?.('off'); reset(); return; }
        if (intent.type === 'set_mode') {
            pendingRef.current = null;               // heard already; the ack ends the exchange
            prefetchRef.current.delete(pending.key);
            applyMode(intent.mode);
            return;
        }
        if (intent.type === 'repeat' || intent.type === 'details') { void speakPendingAndListen(pending); return; }
        // Any other speech after a completion becomes a follow-up message.
        const trimmed = text.trim();
        if (trimmed) {
            playVoiceCue('submit');
            cbRef.current.sendMessage(trimmed, pending.conversationId);
        }
        pendingRef.current = null;
        setStatus('idle');
    }, [speakPendingAndListen, reset, applyMode]);

    const routeTurn = useCallback((kind: TurnKind, text: string) => {
        const trimmed = text.trim();
        if (!trimmed) {
            settle();
            return;
        }
        if (kind === 'composed') {
            playVoiceCue('submit');
            cbRef.current.sendMessage(trimmed, activeConvRef.current);
            settle();
            return;
        }
        const pending = pendingRef.current;
        if (pending?.kind === 'confirmation') handleConfirmationReply(pending, trimmed);
        else if (pending?.kind === 'completion') handleCompletionReply(pending, trimmed);
        else {
            // Reply with nothing pending (e.g. barge-in race): treat as a message.
            playVoiceCue('submit');
            cbRef.current.sendMessage(trimmed, activeConvRef.current);
            setStatus('idle');
        }
    }, [settle, handleConfirmationReply, handleCompletionReply]);

    useEffect(() => { routeRef.current = routeTurn; }, [routeTurn]);

    // ------------------------------------------------------------------
    // Segment dispatch: engaged turn vs open context
    // ------------------------------------------------------------------
    const maybeShortCircuit = useCallback((turn: ActiveTurn) => {
        if (turn.kind !== 'reply') return;
        const text = turn.transcript.text;
        if (!text) return;
        const pending = pendingRef.current;
        const pendingKind = pending?.kind;
        if (!pendingKind) return;
        const isQuestion = pending?.kind === 'confirmation' && pending.request.operation === 'ask_user';
        const intent = parseConfirmationIntent(text, { isQuestion });
        if (!isReplyShortCircuit(intent.type, pendingKind)) return;
        releaseTurn(turn);
        routeRef.current('reply', text);
    }, [releaseTurn]);

    const handleTurnSegment = useCallback((turn: ActiveTurn, wav: Blob, seq: number) => {
        if (turn.baseSeq === null) turn.baseSeq = seq;
        const base = turn.baseSeq;
        turn.inFlight++;
        transcribeAudio(wav, { prompt: STT_BIAS_PROMPT })
            .catch((err) => {
                reportError(err instanceof Error ? err.message : 'Transcription failed');
                return '';
            })
            .then((text) => {
                turn.inFlight--;
                // turnRef stays === turn until complete/cancel/reset, so this
                // single check also aborts segments that resolve after a reset.
                if (turnRef.current !== turn) return;
                markAddressed();
                const action = turn.transcript.addSegment(seq - base, text);
                setLiveTranscript(turn.transcript.text);
                if (turn.finishing) {
                    if (turn.inFlight === 0) completeTurn(turn, turn.transcript.finalize());
                } else if (action.type === 'submit') {
                    completeTurn(turn, action.message);
                } else if (action.type === 'discard') {
                    // "Scratch that": wipe what was said, keep listening for the rephrase.
                    turn.transcript.clear();
                    setLiveTranscript('');
                    playVoiceCue('discard');
                } else if (action.type === 'cancel') {
                    cancelTurn(turn);
                } else {
                    // Typewriter ticks: one per landed word, eyes-free proof of capture.
                    if (text.trim()) playTranscriptTicks(text.trim().split(/\s+/).length);
                    maybeShortCircuit(turn);
                }
            });
    }, [reportError, markAddressed, completeTurn, cancelTurn, maybeShortCircuit]);

    const handleOpenSegment = useCallback((wav: Blob, seq: number) => {
        transcribeAudio(wav, { prompt: STT_BIAS_PROMPT })
            .catch(() => '')
            .then((text) => {
                if (!captureRef.current || turnRef.current) return;
                if (!text || isHallucination(text)) return;
                const addr = parseAddressing(text);
                if (!addr.addressed) return;     // ambient speech: discarded, never logged
                markAddressed();
                const payload = addr.payload;

                if (payload) {
                    const intent = parseConfirmationIntent(payload, { isQuestion: false });
                    if (intent.type === 'stop_listening') {
                        // Breadcrumb: if voice ever self-disables spuriously,
                        // this shows exactly what was (mis)heard.
                        console.warn('[voice] disabled by spoken command:', text);
                        cbRef.current.onModeChange?.('off');
                        reset();
                        return;
                    }
                    if (intent.type === 'set_mode') {
                        applyMode(intent.mode);
                        return;
                    }
                }

                const pending = pendingRef.current;
                if (pending && (!payload || parseGoAhead(payload))) {
                    // "Pipali, go ahead" — acknowledge the waiting announcement.
                    void speakPendingAndListen(pending);
                    return;
                }
                if (!payload) {
                    // Bare "Pipali" with nothing pending: start dictating.
                    openComposedTurn();
                    return;
                }

                // Addressed with content. With an announcement pending it's a reply
                // (decision/guidance/follow-up); otherwise a composed message turn.
                const kind: TurnKind = pending ? 'reply' : 'composed';
                const turn: ActiveTurn = { kind, transcript: new TurnTranscript(), baseSeq: seq, inFlight: 0, finishing: false };
                turnRef.current = turn;
                setStatus('listening');
                playVoiceCue('listening');
                const action = turn.transcript.addSegment(0, payload);
                setLiveTranscript(turn.transcript.text);
                if (action.type === 'submit') completeTurn(turn, action.message);
                else if (action.type === 'cancel') cancelTurn(turn);
                else if (action.type === 'discard') { turn.transcript.clear(); setLiveTranscript(''); playVoiceCue('discard'); }
                else {
                    playTranscriptTicks(payload.split(/\s+/).length);
                    maybeShortCircuit(turn);
                }
            });
    }, [markAddressed, reset, applyMode, speakPendingAndListen, openComposedTurn, completeTurn, cancelTurn, maybeShortCircuit]);

    const handleSegment = useCallback((wav: Blob, seq: number) => {
        const turn = turnRef.current;
        if (turn) handleTurnSegment(turn, wav, seq);
        else handleOpenSegment(wav, seq);
    }, [handleTurnSegment, handleOpenSegment]);
    useEffect(() => { handleSegmentRef.current = handleSegment; }, [handleSegment]);

    // ------------------------------------------------------------------
    // Working heartbeat: a soft pulse per agent step (tool call / mid-run
    // message), throttled so step bursts don't drum. The user hears Pipali's
    // actual work cadence, and the pulses stopping is itself a signal — the
    // completion cue then lands with contrast.
    // ------------------------------------------------------------------
    const lastWorkPulseRef = useRef(0);
    const onStepStart = useCallback((convId: string) => {
        if (cbRef.current.mode === 'off' || !supported) return;
        if (convId !== activeConvRef.current) return;        // active-conversation gate
        if (!captureRef.current || turnRef.current) return;  // session dormant, or mid-exchange
        if (suppressCountRef.current > 0) return;            // Pipali audio already playing
        const now = Date.now();
        if (now - lastWorkPulseRef.current < VOICE_TUNABLES.workPulseMinIntervalMs) return;
        lastWorkPulseRef.current = now;
        playVoiceCue('working');
    }, [supported]);

    // ------------------------------------------------------------------
    // Tap control
    // ------------------------------------------------------------------
    // Tap while listening: send now, no end phrase required.
    const finishListeningTap = useCallback(() => {
        const turn = turnRef.current;
        if (!turn) { setStatus('idle'); return; }
        turn.finishing = true;
        setStatus('transcribing');
        clearInviteTimer();
        captureRef.current?.flush();    // emits the trailing segment synchronously
        if (turn.inFlight === 0) completeTurn(turn, turn.transcript.finalize());
        // Otherwise the last in-flight transcription completes the turn.
    }, [clearInviteTimer, completeTurn]);

    const handleTap = useCallback(() => {
        if (cbRef.current.mode === 'off' || !supported || busyRef.current) return;
        busyRef.current = true;
        const done = () => { busyRef.current = false; };

        const s = status;
        if (s === 'dormant') {
            void startSession().finally(done);
        } else if (s === 'announced') {
            const pending = pendingRef.current;
            if (pending) void speakPendingAndListen(pending).finally(done);
            else { setStatus('idle'); done(); }
        } else if (s === 'speaking') {
            // Barge-in: skip the readout and start the reply.
            stopSpeaking();
            openReplyTurn();
            done();
        } else if (s === 'listening') {
            finishListeningTap();
            done();
        } else if (s === 'idle') {
            // Push-to-talk for general chat (or wake a failed session).
            if (captureRef.current) openComposedTurn();
            else void startSession();
            done();
        } else {
            done(); // transcribing — busy
        }
    }, [status, supported, startSession, speakPendingAndListen, openReplyTurn, finishListeningTap, openComposedTurn]);

    return { status, supported, liveTranscript, handleTap, onConfirmationRequest, onTaskComplete, onStepStart };
}
