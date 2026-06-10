/**
 * Voice companion: the brain of hands-free interaction.
 *
 * Layered over the existing chat/run/confirmation flow — no new agent loop.
 * On a confirmation or completion for the *active* conversation it plays a
 * distinct attention cue and prefetches the spoken summary, then waits for a
 * go-ahead (a tap or any short affirmative) before speaking — so it never talks
 * over the user. After speaking it listens, transcribes, and routes the reply:
 * a confirmation decision, free-form guidance, or a follow-up message.
 *
 * Announcements are gated to the active conversation and deduped so replayed
 * run_complete / confirmation events (reconnect, observe) never double-speak.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationRequest } from '../../server/processor/confirmation/confirmation.types';
import { CONFIRMATION_OPTIONS } from '../../server/processor/confirmation/confirmation.types';
import { VoiceRecorder, isVoiceCaptureSupported, transcribeAudio, synthesizeSpeech } from '../utils/voice-audio';
import { playVoiceCue, speakAudio, stopSpeaking, type VoiceCueProfile } from '../utils/notifications';
import { parseConfirmationIntent, parseGoAhead } from '../utils/voice-intent';
import { buildConfirmationSummary, buildCompletionSummary } from '../utils/voice-summary';

export type VoiceStatus = 'idle' | 'announced' | 'speaking' | 'listening' | 'transcribing';

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

export function useVoiceCompanion(params: UseVoiceCompanionParams) {
    const { enabled, activeConversationId } = params;
    const [status, setStatus] = useState<VoiceStatus>('idle');

    const supported = isVoiceCaptureSupported();

    // Refs so the imperative event handlers always see current values.
    const cbRef = useRef(params);
    useEffect(() => { cbRef.current = params; }, [params]);
    const activeConvRef = useRef(activeConversationId);
    useEffect(() => { activeConvRef.current = activeConversationId; }, [activeConversationId]);

    const pendingRef = useRef<Pending | null>(null);
    const prefetchRef = useRef<Map<string, Promise<ArrayBuffer>>>(new Map());
    const spokenKeysRef = useRef<Set<string>>(new Set());
    const recorderRef = useRef<VoiceRecorder | null>(null);
    const busyRef = useRef(false);

    const reportError = useCallback((message: string) => {
        cbRef.current.onError?.(message);
    }, []);

    const reset = useCallback(() => {
        stopSpeaking();
        recorderRef.current?.cancel();
        recorderRef.current = null;
        pendingRef.current = null;
        busyRef.current = false;
        setStatus('idle');
    }, []);

    // Turning voice off stops any in-flight audio/recording.
    useEffect(() => {
        if (!enabled) reset();
    }, [enabled, reset]);

    const prefetch = useCallback((key: string, text: string) => {
        const p = synthesizeSpeech(text).catch((err) => {
            // Surface once; playback will fall through to listening.
            reportError(err instanceof Error ? err.message : 'Voice synthesis failed');
            throw err;
        });
        prefetchRef.current.set(key, p);
    }, [reportError]);

    const announce = useCallback((pending: Pending, cue: VoiceCueProfile) => {
        playVoiceCue(cue);
        prefetch(pending.key, pending.summary);
        pendingRef.current = pending;
        setStatus('announced');
    }, [prefetch]);

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

    // Record an utterance, transcribe it, and hand back the text.
    const startListening = useCallback(async () => {
        const recorder = new VoiceRecorder();
        recorderRef.current = recorder;
        try {
            await recorder.start();
            setStatus('listening');
        } catch (err) {
            recorderRef.current = null;
            reportError(err instanceof Error ? err.message : 'Microphone unavailable');
            reset();
        }
    }, [reportError, reset]);

    const speakPending = useCallback(async (pending: Pending) => {
        setStatus('speaking');
        try {
            const cached = prefetchRef.current.get(pending.key);
            const audio = cached ? await cached : await synthesizeSpeech(pending.summary);
            await speakAudio(audio);
        } catch {
            // Synthesis/playback failed — fall through to listening anyway.
        } finally {
            prefetchRef.current.delete(pending.key);
        }
        await startListening();
    }, [startListening]);

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
            case 'guidance':
                respond(conversationId, runId, request.requestId, CONFIRMATION_OPTIONS.GUIDANCE, intent.text);
                pendingRef.current = null; setStatus('idle'); break;
            case 'details':
            case 'repeat':
                void speakPending(pending); break;          // re-read, then listen again
            case 'stop_listening':
                cbRef.current.onDisableVoice?.(); reset(); break;
        }
    }, [speakPending, reset]);

    const handleCompletionReply = useCallback((pending: PendingCompletion, text: string) => {
        const intent = parseConfirmationIntent(text, { isQuestion: false });
        if (intent.type === 'stop_listening') { cbRef.current.onDisableVoice?.(); reset(); return; }
        if (intent.type === 'repeat' || intent.type === 'details') { void speakPending(pending); return; }
        // Any other speech after a completion becomes a follow-up message.
        const trimmed = text.trim();
        if (trimmed) cbRef.current.sendMessage(trimmed, pending.conversationId);
        pendingRef.current = null;
        setStatus('idle');
    }, [speakPending, reset]);

    const stopAndProcess = useCallback(async () => {
        const recorder = recorderRef.current;
        if (!recorder) { setStatus('idle'); return; }
        setStatus('transcribing');
        let text = '';
        try {
            const blob = await recorder.stop();
            recorderRef.current = null;
            text = await transcribeAudio(blob);
        } catch (err) {
            recorderRef.current = null;
            reportError(err instanceof Error ? err.message : 'Transcription failed');
            reset();
            return;
        }

        const pending = pendingRef.current;
        if (pending?.kind === 'confirmation') handleConfirmationReply(pending, text);
        else if (pending?.kind === 'completion') handleCompletionReply(pending, text);
        else {
            // General push-to-talk: send as a normal message.
            const trimmed = text.trim();
            if (trimmed) cbRef.current.sendMessage(trimmed, activeConvRef.current);
            setStatus('idle');
        }
    }, [reportError, reset, handleConfirmationReply, handleCompletionReply]);

    // The mic/headphones control. Behavior depends on the current state.
    const handleTap = useCallback(() => {
        if (!cbRef.current.enabled || !supported || busyRef.current) return;
        busyRef.current = true;
        const done = () => { busyRef.current = false; };

        const s = status;
        if (s === 'announced') {
            const pending = pendingRef.current;
            if (pending) void speakPending(pending).finally(done);
            else { reset(); done(); }
        } else if (s === 'speaking') {
            // Barge-in: skip the readout and start listening.
            stopSpeaking();
            void startListening().finally(done);
        } else if (s === 'listening') {
            void stopAndProcess().finally(done);
        } else if (s === 'idle') {
            // Push-to-talk for general chat.
            void startListening().finally(done);
        } else {
            done(); // transcribing — busy
        }
    }, [status, supported, speakPending, startListening, stopAndProcess, reset]);

    return { status, supported, handleTap, onConfirmationRequest, onTaskComplete };
}
