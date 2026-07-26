import { test, expect, describe } from 'bun:test';
import { TurnTranscript, isHallucination, isSelfEcho, isImplausibleSpeechRate, endsWithPhrase, stripTailPhrase } from '../../src/client/utils/voice/voice-turn';
import { STT_BIAS_PROMPT } from '../../src/client/utils/voice/voice-config';

// Verbatim from dogfooding: what STT returned for segments where nothing was
// said. Both are the prompt's command list read back, and neither matched it
// exactly — "nevermind" came back as "Never mind", "Pipali" as "Pipli".
const RECITED_COMMANDS = 'Hey Pipli. Hey Pipali, over to you. Send it. Scratch that. Clear that. Stop listening. Cancel that. Stop. Stop that. Stop it. Stop working. Hold on. Wait. Hang on. Abort. Cancel. Cancel that. Never mind. Never mind. That\'s enough. Enough. Speak freely. Talk freely. Ask first. Ask before speaking. Ask to speak. Go ahead.';
const RECITED_COMMANDS_UNADDRESSED = 'over to you. Send it. Scratch that. Clear that. Stop listening. Cancel that. Stop. Stop that. Stop it. Stop working. Hold on. Wait. Hang on. Abort. Cancel. Cancel that. Never mind. Never mind. That\'s enough. Enough. Speak freely. Talk freely. Ask first. Ask before speaking. Ask to speak. Go ahead.';

describe('isSelfEcho', () => {
    const readout = 'Pipali wants to edit Tasks.org under the Documents folder. Say yes to continue.';

    test('flags a fragment of what Pipali is saying right now', () => {
        for (const s of ['under the Documents folder', 'wants to edit Tasks.org']) {
            expect(isSelfEcho(s, readout)).toBe(true);
        }
    });

    test('flags a single word Pipali is saying — including a decisive one', () => {
        // A bare "yes" that Pipali itself just said cannot be told from an echo,
        // and acting on it would approve an operation nobody asked for.
        expect(isSelfEcho('yes', readout)).toBe(true);
        expect(isSelfEcho('Documents', readout)).toBe(true);
    });

    test('passes a real interruption through', () => {
        for (const s of ['stop', 'no, use the other file', 'wait, what about the backup']) {
            expect(isSelfEcho(s, readout)).toBe(false);
        }
    });

    test('addressed speech is the user by construction', () => {
        expect(isSelfEcho('Pipali, the Documents folder', readout)).toBe(false);
    });

    test('words in common are not enough without the phrasing', () => {
        expect(isSelfEcho('edit the folder yes', readout)).toBe(false);
    });

    test('nothing being spoken means nothing to echo', () => {
        expect(isSelfEcho('yes', '')).toBe(false);
        expect(isSelfEcho('', readout)).toBe(false);
    });
});

describe('isHallucination', () => {
    test('flags known Whisper noise hallucinations', () => {
        for (const s of ['Thank you.', 'Thanks for watching!', 'Thank you for watching.', 'Subtitles by XYZ', '[BLANK_AUDIO]', 'you', '...', '']) {
            expect(isHallucination(s)).toBe(true);
        }
    });

    test('flags any wholly-bracketed tag, not just the enumerated ones', () => {
        for (const s of ['[MUSIC PLAYING]', '[Applause]', '[SOUND]', '[ Silence ]']) {
            expect(isHallucination(s)).toBe(true);
        }
    });

    test('passes real dictation through', () => {
        for (const s of ['Thank the team in the email', 'Research the market for me', 'yes', 'Add [TODO] markers to the file']) {
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

    test('flags the command list read back, addressed or not', () => {
        expect(isHallucination(RECITED_COMMANDS)).toBe(true);
        expect(isHallucination(RECITED_COMMANDS_UNADDRESSED)).toBe(true);
    });

    test('flags a partial echo too short for the speech-rate check to see', () => {
        // A 9-16 word fragment fits its clip honestly, so only the wording
        // check stands between it and the transcript.
        expect(isHallucination('A voice message snippet by the user to Pipali')).toBe(true);
        expect(isHallucination('Speak freely. Talk freely. Ask first. Ask before speaking. Ask to speak. Go ahead.')).toBe(true);
    });

    test('leaves a real utterance built around a command alone', () => {
        for (const s of [
            'Hey Pipali, over to you',
            'Pipali, hold on, wait',
            'stop working on the report and send it over to you',
            'Ask first before speaking to the vendor about the delay',
        ]) {
            expect(isHallucination(s)).toBe(false);
        }
    });

    test('a prompt-echo segment does not pollute the turn transcript', () => {
        const turn = new TurnTranscript();
        turn.addSegment(0, 'Draft the launch email.');
        turn.addSegment(1, STT_BIAS_PROMPT);
        turn.addSegment(2, RECITED_COMMANDS);
        expect(turn.text).toBe('Draft the launch email.');
    });
});

describe('isImplausibleSpeechRate', () => {
    test('flags text no clip that short could hold', () => {
        // The reported recitation: ~50 words out of a segment whose audio is
        // mostly pre-roll and trailing silence.
        expect(isImplausibleSpeechRate(RECITED_COMMANDS, 1_500)).toBe(true);
        expect(isImplausibleSpeechRate('Thanks for watching, and see you in the next video everyone', 900)).toBe(true);
    });

    test('passes speech at any human pace', () => {
        expect(isImplausibleSpeechRate('yes', 1_400)).toBe(false);   // one word, shortest segment
        expect(isImplausibleSpeechRate('Draft the launch email and send it to the team', 3_000)).toBe(false);
        // Rushed delivery: 10 words in 2s of audio is ~5 words/s, near the human ceiling.
        expect(isImplausibleSpeechRate('cancel that and check the logs on the build server', 2_000)).toBe(false);
    });

    test('unknown duration never drops a transcript', () => {
        expect(isImplausibleSpeechRate(RECITED_COMMANDS, 0)).toBe(false);
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
