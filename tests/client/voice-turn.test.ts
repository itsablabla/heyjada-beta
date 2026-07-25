import { test, expect, describe } from 'bun:test';
import { TurnTranscript, isHallucination, endsWithPhrase, stripTailPhrase } from '../../src/client/utils/voice-turn';
import { STT_BIAS_PROMPT } from '../../src/client/utils/voice-config';

describe('isHallucination', () => {
    test('flags known Whisper noise hallucinations', () => {
        for (const s of ['Thank you.', 'Thanks for watching!', 'Thank you for watching.', 'Subtitles by XYZ', '[BLANK_AUDIO]', 'you', '...', '']) {
            expect(isHallucination(s)).toBe(true);
        }
    });

    test('passes real dictation through', () => {
        for (const s of ['Thank the team in the email', 'Research the market for me', 'yes']) {
            expect(isHallucination(s)).toBe(false);
        }
    });

    test('flags echoes of the STT bias prompt, derived from the live constant', () => {
        // Whisper can echo its conditioning text on noise-only audio — verbatim or truncated.
        expect(isHallucination(STT_BIAS_PROMPT)).toBe(true);
        const truncatedEcho = STT_BIAS_PROMPT.split(/\s+/).slice(0, 8).join(' ');
        expect(isHallucination(truncatedEcho)).toBe(true);
    });

    test('short command words contained in the prompt stay usable', () => {
        for (const s of ['Send it.', 'go ahead', 'scratch that', 'Pipali']) {
            expect(isHallucination(s)).toBe(false);
        }
    });

    test('the wake phrase itself is never treated as noise', () => {
        // It was, which meant the one phrase the UI teaches did nothing.
        for (const s of ['Hey Pipali', 'hey pipali', 'Hey Pipali!']) {
            expect(isHallucination(s)).toBe(false);
        }
    });

    test('a prompt-echo segment does not pollute the turn transcript', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Draft the launch email.');
        turn.addSegment(1, STT_BIAS_PROMPT);
        expect(turn.text).toBe('Draft the launch email.');
    });
});

describe('endsWithPhrase', () => {
    test('matches tail tokens through punctuation and filler', () => {
        expect(endsWithPhrase('Draft the reply. Send it!', 'send it')).toBe(true);
        expect(endsWithPhrase('done, over to you', 'over to you')).toBe(true);
        expect(endsWithPhrase('Send it, please.', 'send it')).toBe(true);
    });

    test('requires whole-token tail position', () => {
        expect(endsWithPhrase('please resend it', 'send it')).toBe(false);
        expect(endsWithPhrase('send it to the team', 'send it')).toBe(false);
        expect(endsWithPhrase('send', 'send it')).toBe(false);
    });
});

describe('stripTailPhrase', () => {
    test('removes the phrase and surrounding filler, preserving the message', () => {
        expect(stripTailPhrase('Draft the Q3 report. Send it!', 'send it')).toBe('Draft the Q3 report.');
        expect(stripTailPhrase('Check the logs, um, send it please', 'send it')).toBe('Check the logs');
        expect(stripTailPhrase('Summarize this — over to you.', 'over to you')).toBe('Summarize this');
    });
});

describe('TurnTranscript', () => {
    test('assembles out-of-order segments in sequence order', () => {
        const turn = new TurnTranscript();
        expect(turn.addSegment(1, 'world')).toEqual({ type: 'none' });   // gap: seq 0 missing
        const action = turn.addSegment(0, 'hello');
        expect(turn.text).toBe('hello world');
        expect(action).toEqual({ type: 'none' });
    });

    test('submits when the tail matches an end phrase, stripping it', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Research competitor pricing for me.');
        const action = turn.addSegment(1, 'Send it.');
        expect(action).toEqual({ type: 'submit', message: 'Research competitor pricing for me.' });
    });

    test('does not submit on a mid-content occurrence', () => {
        const turn = new TurnTranscript();
        expect(turn.addSegment(0, 'send it to the whole team today')).toEqual({ type: 'none' });
    });

    test('end phrase split across the assembly gap fires once the gap fills', () => {
        const turn = new TurnTranscript();
        expect(turn.addSegment(1, 'over to you')).toEqual({ type: 'none' });
        const action = turn.addSegment(0, 'Book the meeting room.');
        expect(action).toEqual({ type: 'submit', message: 'Book the meeting room.' });
    });

    test('scratch that / clear that yield discard (clear and keep listening)', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Actually this is all wrong.');
        expect(turn.addSegment(1, 'Scratch that.')).toEqual({ type: 'discard' });
        const other = new TurnTranscript();
        expect(other.addSegment(0, 'clear that')).toEqual({ type: 'discard' });
    });

    test('cancel phrases abandon the turn', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Hmm actually.');
        expect(turn.addSegment(1, 'Stop listening.')).toEqual({ type: 'cancel' });
        const other = new TurnTranscript();
        expect(other.addSegment(0, 'cancel that')).toEqual({ type: 'cancel' });
    });

    test('clear() wipes assembled text but sequence bookkeeping continues', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Wrong start here.');
        turn.addSegment(1, 'Scratch that.');
        turn.clear();
        expect(turn.text).toBe('');
        const action = turn.addSegment(2, 'Better phrasing. Send it.');
        expect(action).toEqual({ type: 'submit', message: 'Better phrasing.' });
    });

    test('hallucinated segments are dropped, not appended', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Summarize the doc.');
        turn.addSegment(1, 'Thank you for watching.');
        expect(turn.text).toBe('Summarize the doc.');
        const action = turn.addSegment(2, 'over to you');
        expect(action).toEqual({ type: 'submit', message: 'Summarize the doc.' });
    });

    test('finalize returns the assembled text without requiring a phrase (tap-to-end)', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Quick question about the deploy');
        expect(turn.finalize()).toBe('Quick question about the deploy');
    });

    test('an empty turn yields empty text and no actions', () => {
        const turn = new TurnTranscript();
        expect(turn.addSegment(0, '')).toEqual({ type: 'none' });
        expect(turn.finalize()).toBe('');
    });
});
