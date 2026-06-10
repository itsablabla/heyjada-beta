/**
 * Speech segmentation over PCM frames for the hands-free turn model.
 *
 * A pause closes a *segment*, never the turn — segments stream to STT while the
 * user keeps thinking. The segmenter keeps a pre-roll ring of recent frames so
 * a segment includes audio from just before detected onset (the first word is
 * where the address lives), and applies hysteresis + a minimum voiced duration
 * so keyboard clatter doesn't produce segments.
 *
 * Pure: frames in, events out. No audio APIs — unit-tested with synthetic PCM.
 * The VAD is pluggable so the energy heuristic can be swapped for a model
 * (e.g. Silero via onnxruntime-web) without touching the state machine.
 */

import { VOICE_TUNABLES } from './voice-config';

export interface VadEngine {
    isVoiced(frame: Float32Array): boolean;
}

export class EnergyVad implements VadEngine {
    constructor(private readonly threshold: number = VOICE_TUNABLES.energyThreshold) {}

    isVoiced(frame: Float32Array): boolean {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
        return Math.sqrt(sum / (frame.length || 1)) >= this.threshold;
    }
}

export interface SegmenterConfig {
    sampleRate: number;
    frameSamples: number;
    preRollMs: number;
    speechStartFrames: number;
    silenceEndMs: number;
    minSpeechMs: number;
    maxSegmentMs: number;
}

export type SegmenterEvent =
    | { type: 'speech_start' }
    | { type: 'segment'; samples: Float32Array }
    | { type: 'segment_rejected'; reason: 'too_short' };

export function defaultSegmenterConfig(sampleRate: number): SegmenterConfig {
    return {
        sampleRate,
        frameSamples: Math.round((sampleRate * VOICE_TUNABLES.analysisFrameMs) / 1000),
        preRollMs: VOICE_TUNABLES.preRollMs,
        speechStartFrames: VOICE_TUNABLES.speechStartFrames,
        silenceEndMs: VOICE_TUNABLES.silenceEndMs,
        minSpeechMs: VOICE_TUNABLES.minSpeechMs,
        maxSegmentMs: VOICE_TUNABLES.maxSegmentMs,
    };
}

export class SpeechSegmenter {
    private readonly frameMs: number;
    private readonly maxPreRollFrames: number;
    private readonly silenceEndFrames: number;
    private readonly minSpeechFrames: number;
    private readonly maxSegmentFrames: number;

    private preRoll: Float32Array[] = [];
    private collecting = false;
    private collected: Float32Array[] = [];
    private voicedRun = 0;
    private silenceRun = 0;
    private voicedFrames = 0;

    constructor(private readonly config: SegmenterConfig, private readonly vad: VadEngine) {
        this.frameMs = (config.frameSamples / config.sampleRate) * 1000;
        this.maxPreRollFrames = Math.max(1, Math.ceil(config.preRollMs / this.frameMs));
        this.silenceEndFrames = Math.max(1, Math.ceil(config.silenceEndMs / this.frameMs));
        this.minSpeechFrames = Math.max(1, Math.ceil(config.minSpeechMs / this.frameMs));
        this.maxSegmentFrames = Math.max(1, Math.ceil(config.maxSegmentMs / this.frameMs));
    }

    pushFrame(frame: Float32Array): SegmenterEvent[] {
        const voiced = this.vad.isVoiced(frame);

        if (!this.collecting) {
            this.preRoll.push(frame.slice());
            if (this.preRoll.length > this.maxPreRollFrames) this.preRoll.shift();

            if (!voiced) {
                this.voicedRun = 0;
                return [];
            }
            this.voicedRun++;
            if (this.voicedRun < this.config.speechStartFrames) return [];

            // Onset confirmed — open a segment seeded with the pre-roll
            // (which already contains the hysteresis frames).
            this.collecting = true;
            this.collected = this.preRoll;
            this.preRoll = [];
            this.voicedFrames = this.voicedRun;
            this.silenceRun = 0;
            return [{ type: 'speech_start' }];
        }

        this.collected.push(frame.slice());
        if (voiced) {
            this.voicedFrames++;
            this.silenceRun = 0;
        } else {
            this.silenceRun++;
        }

        if (this.silenceRun >= this.silenceEndFrames || this.collected.length >= this.maxSegmentFrames) {
            return [this.close()];
        }
        return [];
    }

    /** Force-close any open segment (tap-to-end, teardown). */
    flush(): SegmenterEvent[] {
        if (!this.collecting) return [];
        return [this.close()];
    }

    reset(): void {
        this.preRoll = [];
        this.collected = [];
        this.collecting = false;
        this.voicedRun = 0;
        this.silenceRun = 0;
        this.voicedFrames = 0;
    }

    private close(): SegmenterEvent {
        const frames = this.collected;
        const voicedFrames = this.voicedFrames;
        this.collected = [];
        this.collecting = false;
        this.voicedRun = 0;
        this.silenceRun = 0;
        this.voicedFrames = 0;

        if (voicedFrames < this.minSpeechFrames) {
            return { type: 'segment_rejected', reason: 'too_short' };
        }

        const samples = new Float32Array(frames.length * this.config.frameSamples);
        let offset = 0;
        for (const f of frames) {
            samples.set(f, offset);
            offset += f.length;
        }
        return { type: 'segment', samples };
    }
}
