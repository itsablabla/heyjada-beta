/**
 * PCM helpers for the voice perception layer: downsampling capture-rate audio
 * to the STT rate and encoding it as WAV. Pure functions — no audio APIs.
 */

/** Averaging decimator: good enough for speech, no ringing, O(n). */
export function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return samples;
    if (fromRate < toRate) throw new Error('downsample cannot upsample');
    const ratio = fromRate / toRate;
    const outLength = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += samples[j]!;
        out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
    const dataLength = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeAscii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);

    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]!));
        view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }

    return new Uint8Array(buffer);
}
