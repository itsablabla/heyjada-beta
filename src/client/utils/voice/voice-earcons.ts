/**
 * Earcon language for the eyes-free voice experience — pure data and math.
 * Players (AudioContext scheduling) live in notifications.ts; this module has
 * no side effects so the sound vocabulary itself is unit-testable.
 *
 * One tonal family (C-pentatonic, soft sine) so any two cues heard together
 * sound intentional; the error cue alone sits outside the family so wrongness
 * sounds foreign. Pitch direction is the grammar: rising = a channel opening
 * toward the user, falling = closing/releasing. Two loudness layers: foreground
 * state changes (~0.2–0.3 gain) vs background process textures (≤0.12) that
 * inform mostly by stopping.
 */

export interface EarconNote {
    /** Frequency in Hz. */
    freq: number;
    /** Start offset in seconds. */
    at: number;
    /** Decay duration in seconds. */
    dur: number;
    gain: number;
}

// Pentatonic anchors: C4 262, G4 392, C5 523, E5 659, G5 784, A5 880, C6 1047, E6 1319.
export const VOICE_EARCONS = {
    // Announcements + session boundaries (foreground)
    confirmation: [
        { freq: 659, at: 0, dur: 0.18, gain: 0.3 },     // E5→A5 rising — "I need a decision"
        { freq: 880, at: 0.12, dur: 0.18, gain: 0.3 },
    ],
    complete: [
        { freq: 880, at: 0, dur: 0.18, gain: 0.3 },     // A5→E6 bright rising — "I'm done"
        { freq: 1319, at: 0.12, dur: 0.18, gain: 0.3 },
    ],
    error: [
        { freq: 440, at: 0, dur: 0.18, gain: 0.3 },     // out-of-family fall — "something went wrong"
        { freq: 300, at: 0.12, dur: 0.18, gain: 0.3 },
    ],
    session_start: [
        { freq: 523, at: 0, dur: 0.18, gain: 0.3 },     // C5→G5 — "listening session started"
        { freq: 784, at: 0.12, dur: 0.18, gain: 0.3 },
    ],
    session_end: [
        { freq: 784, at: 0, dur: 0.18, gain: 0.3 },     // G5→C5 — "session ended"
        { freq: 523, at: 0.12, dur: 0.18, gain: 0.3 },
    ],
    // Turn lifecycle (foreground)
    listening: [
        { freq: 880, at: 0, dur: 0.09, gain: 0.25 },    // A5→C6 quick — "go ahead, I'm listening"
        { freq: 1047, at: 0.06, dur: 0.12, gain: 0.25 },
    ],
    submit: [
        { freq: 523, at: 0, dur: 0.08, gain: 0.28 },    // fast ascending run — "handed off, working"
        { freq: 659, at: 0.07, dur: 0.08, gain: 0.28 },
        { freq: 784, at: 0.14, dur: 0.08, gain: 0.28 },
        { freq: 1047, at: 0.21, dur: 0.16, gain: 0.28 },
    ],
    discard: [
        { freq: 880, at: 0, dur: 0.1, gain: 0.18 },     // A5→E5 small fall — "wiped, still listening"
        { freq: 659, at: 0.08, dur: 0.14, gain: 0.18 },
    ],
    cancel: [
        { freq: 784, at: 0, dur: 0.12, gain: 0.2 },     // G5→C5 fall to root — "turn closed"
        { freq: 523, at: 0.1, dur: 0.16, gain: 0.2 },
    ],
    // Background textures (quiet; their *stopping* is also a signal)
    lapse: [
        { freq: 523, at: 0, dur: 0.06, gain: 0.12 },    // single low blip — "reply window closed"
    ],
    working: [
        { freq: 392, at: 0, dur: 0.07, gain: 0.07 },    // soft G4 "lub-dub" heartbeat
        { freq: 392, at: 0.14, dur: 0.07, gain: 0.045 },
    ],
} satisfies Record<string, EarconNote[]>;

export type VoiceCueProfile = keyof typeof VOICE_EARCONS;

/** Background-layer cues: must stay quiet enough to ignore. */
export const BACKGROUND_EARCONS: VoiceCueProfile[] = ['lapse', 'working'];

/** Transcript typewriter ticks: one per landed word, alternating pitch. */
export const TRANSCRIPT_TICK = { freqs: [1175, 1047], dur: 0.025, gain: 0.07, spacing: 0.08, maxTicks: 8 };

/** Total duration of an earcon in milliseconds (for capture-suppression windows). */
export function voiceCueDurationMs(profile: VoiceCueProfile): number {
    const notes: EarconNote[] = VOICE_EARCONS[profile];
    return Math.ceil(Math.max(...notes.map((n) => (n.at + n.dur) * 1000)));
}

/** Tick count for a word count, capped so long sentences stay a short burst. */
export function clampTickCount(wordCount: number): number {
    return Math.min(Math.max(wordCount, 1), TRANSCRIPT_TICK.maxTicks);
}

/** Duration of a tick burst in milliseconds. */
export function tickBurstDurationMs(wordCount: number): number {
    const ticks = clampTickCount(wordCount);
    return Math.ceil(((ticks - 1) * TRANSCRIPT_TICK.spacing + TRANSCRIPT_TICK.dur) * 1000);
}
