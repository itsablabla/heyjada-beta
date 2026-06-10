/**
 * Client-side voice audio: microphone capture (getUserMedia + MediaRecorder)
 * and the network calls to the app's voice routes. Playback lives in the audio
 * layer (notifications.ts) so it can share the AudioContext and a single queue.
 */

import { apiFetch } from './api';

// Chromium MediaRecorder favors webm/opus; WKWebView (Safari/Tauri) favors mp4/aac.
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];

export function pickRecorderMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined') return undefined;
    for (const t of PREFERRED_MIME_TYPES) {
        if (MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return undefined; // let the browser pick its default
}

export function isVoiceCaptureSupported(): boolean {
    return typeof navigator !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== 'undefined';
}

/**
 * Records a single microphone utterance. The caller drives start()/stop();
 * stop() resolves with the recorded audio Blob and releases the mic.
 */
export class VoiceRecorder {
    private recorder?: MediaRecorder;
    private stream?: MediaStream;
    private chunks: Blob[] = [];
    private mimeType?: string;

    async start(): Promise<void> {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mimeType = pickRecorderMimeType();
        this.chunks = [];
        this.recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
        this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
        this.recorder.start();
    }

    isRecording(): boolean {
        return this.recorder?.state === 'recording';
    }

    async stop(): Promise<Blob> {
        return new Promise<Blob>((resolve, reject) => {
            const rec = this.recorder;
            if (!rec) { reject(new Error('Recorder not started')); return; }
            rec.onstop = () => {
                const blob = new Blob(this.chunks, { type: this.mimeType || rec.mimeType || 'audio/webm' });
                this.cleanup();
                resolve(blob);
            };
            try { rec.stop(); } catch (e) { this.cleanup(); reject(e as Error); }
        });
    }

    cancel(): void {
        try { this.recorder?.stop(); } catch { /* ignore */ }
        this.cleanup();
    }

    private cleanup(): void {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = undefined;
        this.recorder = undefined;
        this.chunks = [];
    }
}

export interface VoiceRequestError extends Error {
    status: number;
    code?: string;
}

async function toVoiceError(res: Response): Promise<VoiceRequestError> {
    let message = `Voice request failed (${res.status})`;
    let code: string | undefined;
    try {
        const body = await res.json() as { error?: string; code?: string };
        if (body.error) message = body.error;
        code = body.code;
    } catch { /* non-JSON error body */ }
    const err = new Error(message) as VoiceRequestError;
    err.status = res.status;
    err.code = code;
    return err;
}

function extensionForMime(mime: string): string {
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('wav')) return 'wav';
    return 'webm';
}

/** Transcribe a recorded audio blob to text via the app's voice route. */
export async function transcribeAudio(blob: Blob, opts?: { model?: string; language?: string }): Promise<string> {
    const form = new FormData();
    form.append('file', blob, `utterance.${extensionForMime(blob.type)}`);
    if (opts?.model) form.append('model', opts.model);
    if (opts?.language) form.append('language', opts.language);

    const res = await apiFetch('/api/voice/transcribe', { method: 'POST', body: form });
    if (!res.ok) throw await toVoiceError(res);
    const data = await res.json() as { text?: string };
    return data.text ?? '';
}

/** Synthesize speech audio for text via the app's voice route. */
export async function synthesizeSpeech(
    text: string,
    opts?: { voice?: string; model?: string; format?: string },
): Promise<ArrayBuffer> {
    const res = await apiFetch('/api/voice/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...opts }),
    });
    if (!res.ok) throw await toVoiceError(res);
    return res.arrayBuffer();
}
