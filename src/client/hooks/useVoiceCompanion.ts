/**
 * Voice companion: the brain of hands and eyes-free interaction.
 *
 * Layered over the existing chat/run/confirmation flow — no new agent loop.
 * While voice is enabled, a continuous VAD-gated session listens: the mic stays open,
 * local VAD detects speech, each detected segment is transcribed, and the current parser
 * context decides what acts. Unaddressed ambient speech is discarded.
 *
 * Contexts decide what bare (unaddressed) speech means. Every closed segment
 * falls into exactly one, checked in this order (see handleSegment):
 * - *engaged* — a turn is open, so the speech belongs to it.
 * - *barge-in* over Pipali's speech — it takes the floor: playback stops and
 *   a reply turn opens, once the transcript has cleared the self-echo check.
 * - *open* (the session default) — it means nothing unless it starts with the
 *   addressing phrase ("Pipali, ..."); the rest is ambient and discarded.
 *
 * Engagement is always opened by the user — by addressing Pipali, by tapping,
 * or by Pipali speaking: once it has spoken, a short reply invitation accepts a
 * bare reply, then lapses back to open.
 *
 * Voice mode sets Pipali's speaking etiquette — when it speaks:
 * - `ask_first`: requires go-ahead from user to speak ("Pipali, go ahead" or a
 *    tap). Announcements chime when ready, then wait — minutes if need be.
 *    A polite, low-interruption mode when user is auditorily engaged elsewhere.
 * - `speak_freely`: speaks when it wants — the same chime, then it reads on.
 *    A standing consent for when user is auditorily available.
 * Pipali can always be interrupted - while it is working or speaking.
 * Modes switch at any moment, decoupled from companion state: spoken ("Pipali,
 * speak freely" / "ask first" / "stop listening") in every parser context, or via UI.
 *
 * Turns use the segmented model: pauses close STT segments, never the turn;
 * a live transcript accumulates; turns end on a tail phrase or tap.
 * Reply turns short-circuit on decisive intents ("yes" resolves immediately).
 * Free-form replies like confirmation guidance, follow-ups are sent directly.
 *
 * Safety/limits: an idle timeout that ends the session after prolonged
 * unaddressed silence, announcement dedup across reconnect replays, and an
 * active-conversation gate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationRequest } from '../../server/processor/confirmation/confirmation.types';
import { CONFIRMATION_OPTIONS } from '../../server/processor/confirmation/confirmation.types';
import { isVoiceCaptureSupported, transcribeAudio, synthesizeSpeech, summarizeForSpeech } from '../utils/voice-audio';
import { SegmentedCapture } from '../utils/voice-capture';
import { TurnTranscript, isHallucination, isSelfEcho } from '../utils/voice-turn';
import { VOICE_TUNABLES, STT_BIAS_PROMPT, type VoiceMode } from '../utils/voice-config';
import { playVoiceCue, playTranscriptTicks, speakAudio, stopSpeaking, duckSpeech, voiceCueDurationMs, type VoiceCueProfile } from '../utils/notifications';
import { parseConfirmationIntent, parseGoAhead, parseAddressing, parseStopWork } from '../utils/voice-intent';
import { buildConfirmationSummary, buildConfirmationDetail, buildCompletionSummary } from '../utils/voice-summary';

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
    /** Abandon the run in flight — what "Pipali, stop" means while it works. */
    stopRun?: () => void;
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

type SpokenCommand =
    | { type: 'stop_listening' }
    | { type: 'set_mode'; mode: Exclude<VoiceMode, 'off'> }
    | { type: 'stop_work' }
    | { type: 'dismiss_readout' };

/**
 * Commands that mean the same thing in every context — spoken over a readout,
 * into an open room, or from inside a turn. Pure, so a caller can find out
 * whether speech is a command before tearing down state to act on it.
 *
 * "Stop" reads off what is waiting. With nothing pending it abandons the run in
 * flight; against a finished result it just means "enough, be quiet"; against a
 * confirmation it is a decline, which reply routing already handles, so this
 * stays out of the way. All of them need an exact whole-utterance match — a
 * sentence merely containing "wait" must not throw away work.
 */
function classifySpokenCommand(
    text: string,
    pendingKind: 'confirmation' | 'completion' | null,
): SpokenCommand | null {
    const intent = parseConfirmationIntent(text, { isQuestion: false });
    if (intent.type === 'stop_listening') return { type: 'stop_listening' };
    if (intent.type === 'set_mode') return { type: 'set_mode', mode: intent.mode };
    if (parseStopWork(text)) {
        if (!pendingKind) return { type: 'stop_work' };
        if (pendingKind === 'completion') return { type: 'dismiss_readout' };
    }
    return null;
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
    const speakingRef = useRef(0);
    /** The readout Pipali is (or just was) speaking — what a barge-in is checked against. */
    const spokenTextRef = useRef('');
    const busyRef = useRef(false);
    // Late-bound functions, breaking cycles like segment → route → speak → listen → segment.
    const routeRef = useRef<(kind: TurnKind, text: string) => void>(() => {});
    const handleSegmentRef = useRef<(wav: Blob, seq: number, overlappedPlayback: boolean) => void>(() => {});
    const goDormantRef = useRef<() => void>(() => {});
    const settleRef = useRef<() => void>(() => {});

    const beginSpeaking = useCallback((text: string) => {
        speakingRef.current++;
        spokenTextRef.current = text;
        captureRef.current?.setSpeaking(true);
    }, []);

    const endSpeaking = useCallback(() => {
        speakingRef.current = Math.max(0, speakingRef.current - 1);
        if (speakingRef.current > 0) return;
        // spokenTextRef deliberately survives: a segment captured at the tail of
        // a readout resolves after playback ends and still needs checking
        // against it. The next utterance overwrites it.
        captureRef.current?.setSpeaking(false);
        duckSpeech(false);
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
        // Stale speaking state would start the next session deaf; late TTS releases clamp at zero.
        speakingRef.current = 0;
        spokenTextRef.current = '';
        duckSpeech(false);
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
            onSegment: (wav, seq, overlapped) => handleSegmentRef.current(wav, seq, overlapped),
            onSpeechStart: () => {
                // Speech inside a reply turn cancels the invitation lapse.
                if (turnRef.current) clearInviteTimer();
                // Someone is talking over the readout — quiet down now and let
                // the transcript decide whether it was them or our own echo.
                else if (speakingRef.current > 0) duckSpeech(true);
            },
            onSpeechRejected: () => {
                // A blip that never became a segment: nothing will arrive to
                // decide the duck, so undo it here.
                if (speakingRef.current > 0) duckSpeech(false);
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
    // Speaking (always followed by a reply invitation)
    // ------------------------------------------------------------------
    const speakThenListen = useCallback(async (text: string, getAudio: () => Promise<ArrayBuffer>) => {
        if (!captureRef.current) await startSession();
        setStatus('speaking');
        beginSpeaking(text);
        try {
            await speakAudio(await getAudio());
        } catch {
            // Synthesis/playback failed — fall through to listening anyway.
        } finally {
            endSpeaking();
        }
        // A barge-in — tap or spoken — may already have opened the reply turn;
        // and an interruption that made Pipali speak again (a mode-switch ack)
        // owns the channel now, so this readout no longer invites a reply.
        if (!turnRef.current && speakingRef.current === 0) openReplyTurn();
    }, [startSession, beginSpeaking, endSpeaking, openReplyTurn]);

    const speakPendingAndListen = useCallback(async (pending: Pending) => {
        // Marked on attempt, not success — a failing synthesis must not loop.
        pending.heard = true;
        await speakThenListen(pending.summary, () => {
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
        if (pending && pending.ready && !pending.heard && cbRef.current.mode === 'speak_freely' && speakingRef.current === 0) {
            void speakPendingAndListen(pending);
            return;
        }
        setStatus(pending ? 'announced' : 'idle');
    }, [speakPendingAndListen]);
    useEffect(() => { settleRef.current = settle; }, [settle]);

    /** Short spoken confirmation that doesn't invite a reply (unlike speakThenListen). */
    const speakAck = useCallback(async (text: string) => {
        setStatus('speaking');
        beginSpeaking(text);
        try {
            await speakAudio(await synthesizeSpeech(text));
        } catch {
            // best-effort; the mode switch itself already took effect
        } finally {
            endSpeaking();
        }
        settle();
    }, [beginSpeaking, endSpeaking, settle]);

    const applyMode = useCallback((target: Exclude<VoiceMode, 'off'>) => {
        cbRef.current.onModeChange?.(target);
        void speakAck(target === 'speak_freely'
            ? "Okay, I'll speak as soon as I have something."
            : "Okay, I'll chime first and wait for your go-ahead.");
    }, [speakAck]);

    /** Carry out what classifySpokenCommand identified. Any open turn is the caller's to release first. */
    const runSpokenCommand = useCallback((command: SpokenCommand, heard: string) => {
        switch (command.type) {
            case 'stop_listening':
                // Breadcrumb: if voice ever self-disables spuriously,
                // this shows exactly what was (mis)heard.
                console.warn('[voice] disabled by spoken command:', heard);
                cbRef.current.onModeChange?.('off');
                reset();
                break;
            case 'set_mode':
                applyMode(command.mode);
                break;
            case 'stop_work':
                cbRef.current.stopRun?.();
                playVoiceCue('cancel');
                settleRef.current();
                break;
            case 'dismiss_readout': {
                // "That's enough" — the summary was the whole point; drop it.
                const pending = pendingRef.current;
                if (pending) prefetchRef.current.delete(pending.key);
                pendingRef.current = null;
                playVoiceCue('cancel');
                settleRef.current();
                break;
            }
        }
    }, [reset, applyMode]);

    // A UI switch to speak_freely while an announcement waits unheard reads it
    // immediately — the "okay, just tell me" gesture. Spoken switches land here
    // too, but speakAck already holds the channel then, so settle covers them.
    useEffect(() => {
        if (mode !== 'speak_freely') return;
        const pending = pendingRef.current;
        if (pending && pending.ready && !pending.heard && !turnRef.current && speakingRef.current === 0) {
            void speakPendingAndListen(pending);
        }
    }, [mode, speakPendingAndListen]);

    // ------------------------------------------------------------------
    // Announcements (cues are background notes; they wait to be acknowledged)
    // ------------------------------------------------------------------
    const prefetch = useCallback((pending: Pending): Promise<ArrayBuffer> => {
        const p = (async () => {
            // Enrich via the fast model; the mechanical summary already in
            // pending.summary is the fallback. Updating the pending keeps
            // "repeat"/"details" re-reads consistent with what was played.
            if (pending.kind === 'completion') {
                try {
                    const spoken = (await summarizeForSpeech(pending.raw)).trim();
                    if (spoken) pending.summary = spoken;
                } catch { /* keep the mechanical summary */ }
            } else {
                // Confirmations keep their deterministic frame (intent sentence,
                // risk, trailer); the model only describes content with no spoken
                // form of its own — edit diffs and external tool args.
                const detail = buildConfirmationDetail(pending.request);
                if (detail) {
                    try {
                        const spoken = (await summarizeForSpeech(detail, { kind: 'action' })).trim();
                        if (spoken) pending.summary = buildConfirmationSummary(pending.request, spoken);
                    } catch { /* keep the mechanical summary */ }
                }
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
                if (cbRef.current.mode === 'speak_freely' && !turnRef.current && speakingRef.current === 0) {
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

    /** Fold a transcribed segment into an open turn and act on what the tail implies. */
    const applyTurnText = useCallback((turn: ActiveTurn, seq: number, text: string) => {
        if (turn.baseSeq === null) turn.baseSeq = seq;
        const action = turn.transcript.addSegment(seq - turn.baseSeq, text);
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
            // Re-addressing inside a turn is a command, not dictation. Without
            // this, "Pipali, stop" spoken over a readout lands in the transcript
            // of the reply turn that just opened and sits there — it parses as
            // guidance, which is deliberately not decisive, so nothing happens.
            const addr = parseAddressing(turn.transcript.text);
            const command = addr.addressed && addr.payload
                ? classifySpokenCommand(addr.payload, pendingRef.current?.kind ?? null)
                : null;
            if (command) {
                releaseTurn(turn);
                runSpokenCommand(command, addr.payload);
                return;
            }
            // Typewriter ticks: one per landed word, eyes-free proof of capture.
            if (text.trim()) playTranscriptTicks(text.trim().split(/\s+/).length);
            maybeShortCircuit(turn);
        }
    }, [completeTurn, cancelTurn, maybeShortCircuit]);

    /** Open a turn already carrying its first utterance (addressed speech, barge-in). */
    const beginTurn = useCallback((kind: TurnKind, text: string, seq: number) => {
        const turn: ActiveTurn = { kind, transcript: new TurnTranscript(), baseSeq: seq, inFlight: 0, finishing: false };
        turnRef.current = turn;
        setStatus('listening');
        playVoiceCue('listening');
        applyTurnText(turn, seq, text);
    }, [applyTurnText]);

    const handleTurnSegment = useCallback((turn: ActiveTurn, wav: Blob, seq: number, overlappedPlayback: boolean) => {
        // Claimed at dispatch, not on resolution: segments transcribe concurrently
        // and may land out of order, and the base fixes the transcript's origin.
        if (turn.baseSeq === null) turn.baseSeq = seq;
        turn.inFlight++;
        // A turn can be open while Pipali speaks (tap barge-in, an interruption
        // Pipali answered aloud, the reply invitation that opens the moment a
        // readout ends), so an open turn is not on its own proof the mic is
        // hearing the user. Echo lands as an empty segment rather than a
        // dropped one, so the sequence bookkeeping still closes the turn.
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
                applyTurnText(turn, seq, overlappedPlayback && isSelfEcho(text, spokenTextRef.current) ? '' : text);
            });
    }, [reportError, markAddressed, applyTurnText]);

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
                const pending = pendingRef.current;

                const command = payload ? classifySpokenCommand(payload, pending?.kind ?? null) : null;
                if (command) {
                    runSpokenCommand(command, payload);
                    return;
                }

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
                beginTurn(pending ? 'reply' : 'composed', payload, seq);
            });
    }, [markAddressed, runSpokenCommand, speakPendingAndListen, openComposedTurn, beginTurn]);

    /**
     * Speech captured while Pipali is talking (full duplex only). Playback has
     * already ducked on onset; this decides whether that was the user taking the
     * floor — in which case Pipali stops and the utterance opens a reply — or
     * Pipali's own voice leaking past the echo guard, and it resumes.
     */
    const handleBargeInSegment = useCallback((wav: Blob, seq: number) => {
        transcribeAudio(wav, { prompt: STT_BIAS_PROMPT })
            .catch(() => '')
            .then((text) => {
                if (!captureRef.current) return;   // session ended while this transcribed
                if (!text || isHallucination(text) || isSelfEcho(text, spokenTextRef.current)) {
                    if (speakingRef.current > 0) duckSpeech(false);   // false alarm — resume the readout
                    return;
                }
                markAddressed();
                // The readout may have ended while this transcribed, in which
                // case its reply turn is already open and owns the utterance.
                const turn = turnRef.current;
                if (turn) {
                    applyTurnText(turn, seq, text);
                    return;
                }
                stopSpeaking();
                const addr = parseAddressing(text);
                const payload = addr.addressed ? addr.payload : text;
                const pending = pendingRef.current;
                if (!payload) {
                    openReplyTurn();          // bare "Pipali": floor taken, nothing said yet
                    return;
                }
                const command = classifySpokenCommand(payload, pending?.kind ?? null);
                if (command) {
                    runSpokenCommand(command, payload);
                    return;
                }
                beginTurn(pending ? 'reply' : 'composed', payload, seq);
            });
    }, [markAddressed, applyTurnText, runSpokenCommand, openReplyTurn, beginTurn]);

    const handleSegment = useCallback((wav: Blob, seq: number, overlappedPlayback: boolean) => {
        const turn = turnRef.current;
        if (turn) handleTurnSegment(turn, wav, seq, overlappedPlayback);
        else if (speakingRef.current > 0) handleBargeInSegment(wav, seq);
        else handleOpenSegment(wav, seq);
    }, [handleTurnSegment, handleBargeInSegment, handleOpenSegment]);
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
        if (speakingRef.current > 0) return;                 // Pipali audio already playing
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
