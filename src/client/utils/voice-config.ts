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
    /** Voiced frames within the onset window required to open a segment. */
    speechStartFrames: 3,
    /**
     * Onset window size (frames). Majority voting (3 of 4) instead of strictly
     * consecutive frames, so the consonant dips in short commands ("send it",
     * "Pipali") don't keep resetting onset at normal speaking volume.
     */
    speechStartWindow: 4,
    /** Trailing silence that closes a segment — a pause, never the turn. */
    silenceEndMs: 900,
    /** Segments with less voiced audio than this are rejected as blips. */
    minSpeechMs: 200,
    /** Safety cap: force-close a segment that runs this long. */
    maxSegmentMs: 30_000,
    /** Sample rate segments are downsampled to before WAV-encoding for STT. */
    sttSampleRate: 16_000,
    /** How long after Pipali finishes speaking that bare speech counts as the reply. */
    replyInvitationMs: 10_000,
    /** Session ends (dormant) after this long without addressed speech. */
    idleTimeoutMs: 900_000,
    /** Minimum gap between work heartbeat pulses (steps can fire in bursts). */
    workPulseMinIntervalMs: 1_000,
} as const;

/** Tail-position phrases that submit the current turn. */
export const END_PHRASES = ['over to you', 'send it'];

/** Tail-position phrases that clear the transcript but keep listening (rephrase). */
export const DISCARD_PHRASES = ['scratch that', 'clear that'];

/** Tail-position phrases that abandon the turn and stop listening. */
export const CANCEL_PHRASES = ['stop listening', 'cancel that'];

/** Max text length accepted by /api/voice/summarize (keep in sync with the server schema). */
export const SUMMARIZE_TEXT_CAP = 50_000;

/** The addressing word that marks open-context speech as meant for Pipali. */
export const ADDRESS_NAME = 'pipali';

/** Lead-in words allowed before the addressing word ("hey Pipali", "ok Pipali"). */
export const ADDRESS_LEAD_INS = ['hey', 'ok', 'okay', 'hi'];

/**
 * STT prompt to prime the decoder with context, proper nouns and command phrases
 * to make them transcribe reliably for the given context.
 */
export const STT_BIAS_PROMPT =
    `A voice message snippet by the user to Pipali, an AI co-worker on their computer. Key Phrases: Pipali, Hey Pipali, ${[...END_PHRASES, ...DISCARD_PHRASES, ...CANCEL_PHRASES].join(', ')}, go ahead.`;
