/**
 * Continuous microphone capture for segmented hands-free turns.
 *
 * AudioWorklet taps raw PCM off the mic stream; frames feed the pure
 * SpeechSegmenter, and each closed segment is downsampled to the STT rate and
 * WAV-encoded. AudioWorklet (not MediaRecorder) because segments need pre-roll
 * spliced from a ring buffer and mid-stream MediaRecorder chunks lack container
 * headers; WKWebView supports worklets (Safari 14.1+).
 *
 * Capture keeps running while Pipali speaks (full duplex). The platform's own
 * echo cancellation is what makes that possible — measured on macOS, it drops
 * Pipali's voice at the mic to well under the voiced threshold. `setSpeaking`
 * tells the segmenter when a readout is on so it can raise that threshold for
 * the residual, and mark the segments that caught any of it.
 */

import { VOICE_TUNABLES } from './voice-config';
import { SpeechSegmenter, EnergyVad, defaultSegmenterConfig } from './voice-segmenter';
import { downsample, encodeWavPcm16 } from './voice-pcm';

// Inlined worklet processor, loaded via Blob URL so no bundler asset plumbing
// is needed. It forwards each 128-sample render quantum to the main thread.
const WORKLET_SOURCE = `
class PipaliPcmTap extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && channel.length) this.port.postMessage(channel.slice(0));
        return true;
    }
}
registerProcessor('pipali-pcm-tap', PipaliPcmTap);
`;

export interface SegmentedCaptureHandlers {
    /**
     * A speech segment closed: WAV-encoded audio at the STT sample rate.
     * `overlappedPlayback` marks audio that caught Pipali's own voice, which
     * stays true after playback has ended — see SegmenterEvent.
     */
    onSegment: (wav: Blob, seq: number, overlappedPlayback: boolean) => void;
    onSpeechStart?: () => void;
    /** Onset was a blip — nothing to transcribe, so anything onset triggered can unwind. */
    onSpeechRejected?: () => void;
}

export class SegmentedCapture {
    private stream?: MediaStream;
    private ctx?: AudioContext;
    private source?: MediaStreamAudioSourceNode;
    private node?: AudioWorkletNode;
    private sink?: GainNode;
    private segmenter?: SpeechSegmenter;
    private frameBuf?: Float32Array;
    private frameFill = 0;
    private seq = 0;
    private stopped = false;

    constructor(private readonly handlers: SegmentedCaptureHandlers) {}

    async start(): Promise<void> {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
        });
        // The constraint is advisory, and full duplex leans on it being honoured
        // — so log what the engine actually applied, not what we asked for.
        const settings = this.stream.getAudioTracks()[0]?.getSettings();
        console.info('[voice] capture:', {
            echoCancellation: settings?.echoCancellation ?? 'unreported',
            noiseSuppression: settings?.noiseSuppression ?? 'unreported',
        });
        this.ctx = new AudioContext();
        if (this.ctx.state === 'suspended') await this.ctx.resume();

        const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
            await this.ctx.audioWorklet.addModule(workletUrl);
        } finally {
            URL.revokeObjectURL(workletUrl);
        }

        const config = defaultSegmenterConfig(this.ctx.sampleRate);
        this.segmenter = new SpeechSegmenter(config, new EnergyVad());
        this.frameBuf = new Float32Array(config.frameSamples);
        this.frameFill = 0;

        this.source = this.ctx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(this.ctx, 'pipali-pcm-tap');
        this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.ingest(e.data);
        this.source.connect(this.node);
        // Some engines only run worklets connected toward the destination;
        // a zero-gain sink keeps the graph alive without mic→speaker feedback.
        this.sink = this.ctx.createGain();
        this.sink.gain.value = 0;
        this.node.connect(this.sink);
        this.sink.connect(this.ctx.destination);
    }

    /** A readout is on: raise the voiced bar, and mark segments that catch it. */
    setSpeaking(speaking: boolean): void {
        this.segmenter?.setSpeaking(speaking);
    }

    /** Force-close any open segment (tap-to-end). */
    flush(): void {
        if (!this.segmenter) return;
        for (const event of this.segmenter.flush()) this.handleEvent(event);
    }

    stop(): void {
        this.stopped = true;
        if (this.node) this.node.port.onmessage = null;
        try { this.source?.disconnect(); } catch { /* already disconnected */ }
        try { this.node?.disconnect(); } catch { /* already disconnected */ }
        try { this.sink?.disconnect(); } catch { /* already disconnected */ }
        this.stream?.getTracks().forEach((t) => t.stop());
        void this.ctx?.close().catch(() => {});
        this.stream = undefined;
        this.ctx = undefined;
        this.segmenter = undefined;
    }

    private ingest(chunk: Float32Array): void {
        if (this.stopped || !this.segmenter || !this.frameBuf) return;
        let offset = 0;
        while (offset < chunk.length) {
            const take = Math.min(chunk.length - offset, this.frameBuf.length - this.frameFill);
            this.frameBuf.set(chunk.subarray(offset, offset + take), this.frameFill);
            this.frameFill += take;
            offset += take;
            if (this.frameFill === this.frameBuf.length) {
                this.frameFill = 0;
                for (const event of this.segmenter.pushFrame(this.frameBuf)) this.handleEvent(event);
            }
        }
    }

    private handleEvent(event: ReturnType<SpeechSegmenter['pushFrame']>[number]): void {
        if (event.type === 'speech_start') {
            this.handlers.onSpeechStart?.();
        } else if (event.type === 'segment') {
            const rate = this.ctx?.sampleRate ?? VOICE_TUNABLES.sttSampleRate;
            const ds = downsample(event.samples, rate, Math.min(rate, VOICE_TUNABLES.sttSampleRate));
            const wav = encodeWavPcm16(ds, Math.min(rate, VOICE_TUNABLES.sttSampleRate));
            this.handlers.onSegment(new Blob([wav], { type: 'audio/wav' }), this.seq++, event.overlappedPlayback);
        } else {
            this.handlers.onSpeechRejected?.();   // blip: no audio to transcribe
        }
    }
}
