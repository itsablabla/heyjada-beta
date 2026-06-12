import { test, expect, describe } from 'bun:test';
import {
    VOICE_EARCONS,
    BACKGROUND_EARCONS,
    TRANSCRIPT_TICK,
    voiceCueDurationMs,
    clampTickCount,
    tickBurstDurationMs,
    type VoiceCueProfile,
} from '../../src/client/utils/voice-earcons';

const profiles = Object.keys(VOICE_EARCONS) as VoiceCueProfile[];
const background = new Set<VoiceCueProfile>(BACKGROUND_EARCONS);

describe('earcon vocabulary invariants', () => {
    test('every earcon has notes and stays short (interjections, not music)', () => {
        for (const p of profiles) {
            expect(VOICE_EARCONS[p].length).toBeGreaterThan(0);
            expect(voiceCueDurationMs(p)).toBeLessThanOrEqual(600);
        }
    });

    test('loudness layers: background cues stay quiet, foreground stays bounded', () => {
        for (const p of profiles) {
            for (const note of VOICE_EARCONS[p]) {
                if (background.has(p)) expect(note.gain).toBeLessThanOrEqual(0.12);
                else expect(note.gain).toBeLessThanOrEqual(0.3);
                expect(note.gain).toBeGreaterThan(0);
            }
        }
    });

    test('pitch grammar: opening cues rise, closing cues fall', () => {
        const pitchDirection = (p: VoiceCueProfile) => {
            const notes = VOICE_EARCONS[p];
            return Math.sign(notes[notes.length - 1]!.freq - notes[0]!.freq);
        };
        for (const p of ['listening', 'submit', 'session_start', 'confirmation', 'complete'] as const) {
            expect(pitchDirection(p)).toBe(1);
        }
        for (const p of ['discard', 'cancel', 'session_end', 'error'] as const) {
            expect(pitchDirection(p)).toBe(-1);
        }
    });

    test('background textures stay below the VAD minimum-speech duration', () => {
        // Suppression also guards these, but even unsuppressed speaker bleed
        // must not be able to form a speech segment (minSpeechMs is 200).
        for (const p of BACKGROUND_EARCONS) {
            for (const note of VOICE_EARCONS[p]) {
                expect(note.dur * 1000).toBeLessThan(200);
            }
        }
    });
});

describe('transcript ticks', () => {
    test('one tick per word, capped for long sentences', () => {
        expect(clampTickCount(0)).toBe(1);
        expect(clampTickCount(3)).toBe(3);
        expect(clampTickCount(40)).toBe(TRANSCRIPT_TICK.maxTicks);
    });

    test('burst duration grows with words and stays brief at the cap', () => {
        expect(tickBurstDurationMs(1)).toBeLessThan(tickBurstDurationMs(5));
        expect(tickBurstDurationMs(100)).toBeLessThanOrEqual(1000);
    });
});
