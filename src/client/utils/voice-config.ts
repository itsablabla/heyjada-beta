/**
 * Tunable constants and spoken-command phrase sets for the hands-free voice
 * pipeline, grouped here per the voice spec so dogfooding adjustments touch
 * one module. Spoken command phrases are English-only for now; keeping the
 * sets here is what makes later localization a data change, not a code change.
 */

export const VOICE_TUNABLES = {
    /** Audio kept before detected speech onset so the first word isn't clipped. */
    preRollMs: 300,
    /** VAD analysis frame length. */
    analysisFrameMs: 30,
    /** RMS threshold (on [-1,1] float samples) above which a frame counts as voiced. */
    energyThreshold: 0.015,
    /** Consecutive voiced frames required to open a segment (hysteresis). */
    speechStartFrames: 3,
    /** Trailing silence that closes a segment — a pause, never the turn. */
    silenceEndMs: 900,
    /** Segments with less voiced audio than this are rejected as blips. */
    minSpeechMs: 300,
    /** Safety cap: force-close a segment that runs this long. */
    maxSegmentMs: 30_000,
    /** Sample rate segments are downsampled to before WAV-encoding for STT. */
    sttSampleRate: 16_000,
} as const;

/** Tail-position phrases that submit the current turn. */
export const END_PHRASES = ['over to you', 'send it'];

/** Tail-position phrases that clear the transcript but keep listening (rephrase). */
export const DISCARD_PHRASES = ['scratch that', 'clear that'];

/** Tail-position phrases that abandon the turn and stop listening. */
export const CANCEL_PHRASES = ['stop listening', 'cancel that'];
