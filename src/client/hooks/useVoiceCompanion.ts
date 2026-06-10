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
 * Turns use the segmented model (Phase A): pauses close STT segments, never
 * the turn; a live transcript accumulates; turns end on a tail phrase or tap.
 * Reply turns short-circuit on decisive intents ("yes" resolves immediately).
 * Unmatched confirmation replies are echoed back before reaching the agent.
 *
 * Safety/limits: half-duplex (capture suppressed while Pipali plays audio),
 * an idle timeout that ends the session after prolonged unaddressed silence,
 * announcement dedup across reconnect replays, and an active-conversation gate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationRequest } from '../../server/processor/confirmation/confirmation.types';
import { CONFIRMATION_OPTIONS } from '../../server/processor/confirmation/confirmation.types';
import { isVoiceCaptureSupported, transcribeAudio, synthesizeSpeech } from '../utils/voice-audio';
import { SegmentedCapture } from '../utils/voice-capture';
import { TurnTranscript, isHallucination } from '../utils/voice-turn';
import { VOICE_TUNABLES, STT_BIAS_PROMPT } from '../utils/voice-config';
import { playVoiceCue, speakAudio, stopSpeaking, type VoiceCueProfile } from '../utils/notifications';
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
}
interface PendingCompletion {
    kind: 'completion';
    key: string;
    conversationId: string;
    summary: string;
}
type Pending = PendingConfirmation | PendingCompletion;

interface GuidanceEcho {
    pending: PendingConfirmation;
    guidance: string;
}

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
    enabled: boolean;
    activeConversationId: string | undefined;
    sendMessage: (text: string, conversationId?: string) => void;
    respondToConfirmation: (conversationId: string, runId: string, requestId: string, optionId: string, guidance?: string) => void;
    onError?: (message: string) => void;
    onDisableVoice?: () => void;
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
function isReplyShortCircuit(intentType: string, pendingKind: 'confirmation' | 'completion' | 'echo'): boolean {
    if (intentType === 'guidance') return false;
    if (pendingKind === 'completion') return ['repeat', 'details', 'stop_listening'].includes(intentType);
    return true;
}

export function useVoiceCompanion(params: UseVoiceCompanionParams) {
    const { enabled, activeConversationId } = params;
    const [status, setStatus] = useState<VoiceStatus>('idle');
    const [liveTranscript, setLiveTranscript] = useState('');

    const supported = isVoiceCaptureSupported();

    // Refs so the imperative event handlers always see current values.
    const cbRef = useRef(params);
    useEffect(() => { cbRef.current = params; }, [params]);
    const activeConvRef = useRef(activeConversationId);
    useEffect(() => { activeConvRef.current = activeConversationId; }, [activeConversationId]);

    const pendingRef = useRef<Pending | null>(null);
    const echoRef = useRef<GuidanceEcho | null>(null);
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

    const reportError = useCallback((message: string) => {
        cbRef.current.onError?.(message);
    }, []);

    // ------------------------------------------------------------------
    // Half-duplex: capture is suppressed while any Pipali audio plays.
    // Counted so an attention cue ending early can't unsuppress mid-TTS.
    // ------------------------------------------------------------------
    const acquireSuppression = useCallback(() => {
        suppressCountRef.current++;
        captureRef.current?.setSuppressed(true);
    }, []);
    const releaseSuppression = useCallback(() => {
        suppressCountRef.current = Math.max(0, suppressCountRef.current - 1);
        if (suppressCountRef.current === 0) captureRef.current?.setSuppressed(false);
    }, []);
    const playCue = useCallback((profile: VoiceCueProfile) => {
        acquireSuppression();
        playVoiceCue(profile);
        setTimeout(releaseSuppression, VOICE_TUNABLES.cueSuppressMs);
    }, [acquireSuppression, releaseSuppression]);

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
        setStatus(pendingRef.current ? 'announced' : 'idle');
    }, [releaseTurn]);

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------
    const stopSession = useCallback((withCue: boolean) => {
        sessionTokenRef.current++;
        clearInviteTimer();
        clearIdleTimer();
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
        playCue('session_start');
        setStatus(pendingRef.current ? 'announced' : 'idle');
        markAddressed();
    }, [supported, reportError, playCue, markAddressed, clearInviteTimer]);

    const reset = useCallback(() => {
        stopSpeaking();
        stopSession(false);
        pendingRef.current = null;
        echoRef.current = null;
        busyRef.current = false;
        setLiveTranscript('');
        setStatus('idle');
    }, [stopSession]);

    // The session lives exactly as long as voice is enabled.
    useEffect(() => {
        if (!enabled || !supported) {
            reset();
            return;
        }
        void startSession();
        return () => stopSession(false);
    }, [enabled, supported, startSession, stopSession, reset]);

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
        const pending = pendingRef.current;
        if (echoRef.current) {
            echoRef.current = null;
            setStatus('announced');             // confirmation still unanswered
        } else if (pending?.kind === 'completion') {
            pendingRef.current = null;          // summary was heard; nothing more owed
            setStatus('idle');
        } else {
            setStatus(pending ? 'announced' : 'idle');
        }
    }, [releaseTurn]);

    const openReplyTurn = useCallback(() => {
        const turn: ActiveTurn = { kind: 'reply', transcript: new TurnTranscript(), baseSeq: null, inFlight: 0, finishing: false };
        turnRef.current = turn;
        setLiveTranscript('');
        setStatus('listening');
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
        await speakThenListen(() => {
            const cached = prefetchRef.current.get(pending.key);
            prefetchRef.current.delete(pending.key);
            return cached ?? synthesizeSpeech(pending.summary);
        });
    }, [speakThenListen]);

    const speakEcho = useCallback((echo: GuidanceEcho) => {
        const text = `I heard: ${echo.guidance}. Say yes to send it, or no to discard.`;
        void speakThenListen(() => synthesizeSpeech(text));
    }, [speakThenListen]);

    // ------------------------------------------------------------------
    // Announcements (cues are background notes; they wait to be acknowledged)
    // ------------------------------------------------------------------
    const prefetch = useCallback((key: string, text: string) => {
        const p = synthesizeSpeech(text).catch((err) => {
            reportError(err instanceof Error ? err.message : 'Voice synthesis failed');
            throw err;
        });
        prefetchRef.current.set(key, p);
    }, [reportError]);

    const announce = useCallback((pending: Pending, cue: VoiceCueProfile) => {
        playCue(cue);
        prefetch(pending.key, pending.summary);
        pendingRef.current = pending;
        // Don't disturb an open turn or active speech; the pending state is
        // picked up when the current exchange settles.
        setStatus((s) => (s === 'idle' || s === 'announced' ? 'announced' : s));
    }, [playCue, prefetch]);

    const onConfirmationRequest = useCallback((request: ConfirmationRequest, convId: string, runId: string) => {
        if (!cbRef.current.enabled || !supported) return;
        if (convId !== activeConvRef.current) return;            // active-conversation gate
        const key = `c:${request.requestId}`;
        if (spokenKeysRef.current.has(key)) return;              // dedup replays
        spokenKeysRef.current.add(key);
        announce({ kind: 'confirmation', key, conversationId: convId, runId, request, summary: buildConfirmationSummary(request) }, 'confirmation');
    }, [supported, announce]);

    const onTaskComplete = useCallback((response: string, convId: string) => {
        if (!cbRef.current.enabled || !supported) return;
        if (convId !== activeConvRef.current) return;
        // No runId in the completion callback — key on content so replays dedup.
        const key = `t:${convId}:${response.length}:${response.slice(0, 32)}`;
        if (spokenKeysRef.current.has(key)) return;
        spokenKeysRef.current.add(key);
        announce({ kind: 'completion', key, conversationId: convId, summary: buildCompletionSummary(response) }, 'complete');
    }, [supported, announce]);

    // ------------------------------------------------------------------
    // Reply routing
    // ------------------------------------------------------------------
    const handleEchoReply = useCallback((echo: GuidanceEcho, text: string) => {
        echoRef.current = null;
        const intent = parseConfirmationIntent(text, { isQuestion: false });
        const { pending, guidance } = echo;
        if (intent.type === 'approve' || intent.type === 'approve_dont_ask') {
            cbRef.current.respondToConfirmation(
                pending.conversationId, pending.runId, pending.request.requestId,
                CONFIRMATION_OPTIONS.GUIDANCE, guidance,
            );
            pendingRef.current = null;
            setStatus('idle');
        } else if (intent.type === 'stop_listening') {
            cbRef.current.onDisableVoice?.();
            reset();
        } else if (intent.type === 'repeat') {
            echoRef.current = echo;
            speakEcho(echo);
        } else {
            // Declined (or anything else): drop the guidance, keep the confirmation pending.
            setStatus('announced');
        }
    }, [reset, speakEcho]);

    const handleConfirmationReply = useCallback((pending: PendingConfirmation, text: string) => {
        const isQuestion = pending.request.operation === 'ask_user';
        const intent = parseConfirmationIntent(text, { isQuestion });
        const { conversationId, runId, request } = pending;
        const { primary, decline, dontAsk } = resolveOptionIds(request);
        const respond = cbRef.current.respondToConfirmation;

        switch (intent.type) {
            case 'approve':
                if (primary) respond(conversationId, runId, request.requestId, primary.id);
                pendingRef.current = null; setStatus('idle'); break;
            case 'approve_dont_ask':
                if (dontAsk) respond(conversationId, runId, request.requestId, dontAsk.id);
                else if (primary) respond(conversationId, runId, request.requestId, primary.id);
                pendingRef.current = null; setStatus('idle'); break;
            case 'decline':
                if (decline) respond(conversationId, runId, request.requestId, decline.id);
                pendingRef.current = null; setStatus('idle'); break;
            case 'guidance': {
                // Echo-back safety: never forward unmatched speech to the agent silently.
                const echo: GuidanceEcho = { pending, guidance: intent.text };
                echoRef.current = echo;
                speakEcho(echo);
                break;
            }
            case 'details':
            case 'repeat':
                void speakPendingAndListen(pending); break;  // re-read, then listen again
            case 'stop_listening':
                cbRef.current.onDisableVoice?.(); reset(); break;
        }
    }, [speakPendingAndListen, speakEcho, reset]);

    const handleCompletionReply = useCallback((pending: PendingCompletion, text: string) => {
        const intent = parseConfirmationIntent(text, { isQuestion: false });
        if (intent.type === 'stop_listening') { cbRef.current.onDisableVoice?.(); reset(); return; }
        if (intent.type === 'repeat' || intent.type === 'details') { void speakPendingAndListen(pending); return; }
        // Any other speech after a completion becomes a follow-up message.
        const trimmed = text.trim();
        if (trimmed) cbRef.current.sendMessage(trimmed, pending.conversationId);
        pendingRef.current = null;
        setStatus('idle');
    }, [speakPendingAndListen, reset]);

    const routeTurn = useCallback((kind: TurnKind, text: string) => {
        const trimmed = text.trim();
        if (!trimmed) {
            setStatus(pendingRef.current ? 'announced' : 'idle');
            return;
        }
        if (kind === 'composed') {
            cbRef.current.sendMessage(trimmed, activeConvRef.current);
            setStatus(pendingRef.current ? 'announced' : 'idle');
            return;
        }
        const echo = echoRef.current;
        if (echo) { handleEchoReply(echo, trimmed); return; }
        const pending = pendingRef.current;
        if (pending?.kind === 'confirmation') handleConfirmationReply(pending, trimmed);
        else if (pending?.kind === 'completion') handleCompletionReply(pending, trimmed);
        else {
            // Reply with nothing pending (e.g. barge-in race): treat as a message.
            cbRef.current.sendMessage(trimmed, activeConvRef.current);
            setStatus('idle');
        }
    }, [handleEchoReply, handleConfirmationReply, handleCompletionReply]);

    useEffect(() => { routeRef.current = routeTurn; }, [routeTurn]);

    // ------------------------------------------------------------------
    // Segment dispatch: engaged turn vs open context
    // ------------------------------------------------------------------
    const maybeShortCircuit = useCallback((turn: ActiveTurn) => {
        if (turn.kind !== 'reply') return;
        const text = turn.transcript.text;
        if (!text) return;
        const echo = echoRef.current;
        const pending = pendingRef.current;
        const pendingKind = echo ? 'echo' : pending?.kind;
        if (!pendingKind) return;
        const isQuestion = !echo && pending?.kind === 'confirmation' && pending.request.operation === 'ask_user';
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
                } else if (action.type === 'cancel') {
                    cancelTurn(turn);
                } else {
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
                        cbRef.current.onDisableVoice?.();
                        reset();
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
                const action = turn.transcript.addSegment(0, payload);
                setLiveTranscript(turn.transcript.text);
                if (action.type === 'submit') completeTurn(turn, action.message);
                else if (action.type === 'cancel') cancelTurn(turn);
                else if (action.type === 'discard') { turn.transcript.clear(); setLiveTranscript(''); }
                else maybeShortCircuit(turn);
            });
    }, [markAddressed, reset, speakPendingAndListen, openComposedTurn, completeTurn, cancelTurn, maybeShortCircuit]);

    const handleSegment = useCallback((wav: Blob, seq: number) => {
        const turn = turnRef.current;
        if (turn) handleTurnSegment(turn, wav, seq);
        else handleOpenSegment(wav, seq);
    }, [handleTurnSegment, handleOpenSegment]);
    useEffect(() => { handleSegmentRef.current = handleSegment; }, [handleSegment]);

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
        if (!cbRef.current.enabled || !supported || busyRef.current) return;
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

    return { status, supported, liveTranscript, handleTap, onConfirmationRequest, onTaskComplete };
}
