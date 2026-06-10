/**
 * Client-side voice audio: capture support detection and the network calls to
 * the app's voice routes. Capture itself lives in voice-capture.ts (AudioWorklet);
 * playback lives in notifications.ts so it can share the AudioContext and queue.
 */

import { apiFetch } from './api';

/** Segmented capture needs getUserMedia + AudioWorklet (Safari/WKWebView 14.1+, Chromium, Firefox). */
export function isVoiceCaptureSupported(): boolean {
    return typeof navigator !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia
        && typeof AudioContext !== 'undefined'
        && typeof AudioWorkletNode !== 'undefined';
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
export async function transcribeAudio(blob: Blob, opts?: { model?: string; language?: string; prompt?: string }): Promise<string> {
    const form = new FormData();
    form.append('file', blob, `utterance.${extensionForMime(blob.type)}`);
    if (opts?.model) form.append('model', opts.model);
    if (opts?.language) form.append('language', opts.language);
    if (opts?.prompt) form.append('prompt', opts.prompt);

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
