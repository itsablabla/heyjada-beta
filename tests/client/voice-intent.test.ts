import { test, expect, describe } from 'bun:test';
import { parseConfirmationIntent, parseGoAhead, parseAddressing, normalizeUtterance } from '../../src/client/utils/voice-intent';

describe('normalizeUtterance', () => {
    test('lowercases, strips punctuation/apostrophes, and drops filler', () => {
        expect(normalizeUtterance('Um, Yes please!')).toBe('yes');
        expect(normalizeUtterance("Don't ask again.")).toBe('dont ask again');
        expect(normalizeUtterance('   ')).toBe('');
    });
});

describe('parseGoAhead', () => {
    test('accepts affirmatives, details requests, and readiness phrases', () => {
        for (const s of ['yes', 'ok', 'go ahead', 'sure', 'details', 'tell me', 'ready', 'go on']) {
            expect(parseGoAhead(s)).toBe(true);
        }
    });
    test('rejects empty or unrelated speech', () => {
        expect(parseGoAhead('')).toBe(false);
        expect(parseGoAhead('what is the meaning of life')).toBe(false);
    });
});

describe('parseAddressing', () => {
    test('matches the address word with payload extraction', () => {
        expect(parseAddressing('Pipali, also check the logs')).toEqual({ addressed: true, payload: 'also check the logs' });
        expect(parseAddressing('pipali go ahead')).toEqual({ addressed: true, payload: 'go ahead' });
    });

    test('allows lead-ins like hey/ok', () => {
        expect(parseAddressing('Hey Pipali, what is pending?')).toEqual({ addressed: true, payload: 'what is pending?' });
        expect(parseAddressing('Okay Pipali')).toEqual({ addressed: true, payload: '' });
    });

    test('tolerates STT mangling of the proper noun', () => {
        expect(parseAddressing('Bipali, summarize this').addressed).toBe(true);
        expect(parseAddressing('Pipally check the deploy').addressed).toBe(true);
        expect(parseAddressing('Pip ali, run the report').addressed).toBe(true);
    });

    test('rejects unaddressed ambient speech', () => {
        for (const s of ['the pipeline is broken', 'happily ever after', 'yes, exactly', 'can you pass the salt', '']) {
            expect(parseAddressing(s).addressed).toBe(false);
        }
    });

    test('requires the address word at the start, not mid-sentence', () => {
        expect(parseAddressing('I told Pipali to check it').addressed).toBe(false);
    });
});

describe('parseConfirmationIntent (non-question)', () => {
    const opts = { isQuestion: false };

    test('approve words', () => {
        for (const s of ['yes', 'yeah', 'go ahead', 'do it', 'proceed', 'confirm']) {
            expect(parseConfirmationIntent(s, opts)).toEqual({ type: 'approve' });
        }
    });

    test('decline words', () => {
        for (const s of ['no', 'nope', 'cancel', 'reject', 'never mind']) {
            expect(parseConfirmationIntent(s, opts)).toEqual({ type: 'decline' });
        }
    });

    test('"don\'t ask again" → approve_dont_ask', () => {
        expect(parseConfirmationIntent("yes, don't ask again", opts)).toEqual({ type: 'approve_dont_ask' });
        expect(parseConfirmationIntent('always', opts)).toEqual({ type: 'approve_dont_ask' });
    });

    test('details and repeat', () => {
        expect(parseConfirmationIntent('details', opts)).toEqual({ type: 'details' });
        expect(parseConfirmationIntent('tell me more', opts)).toEqual({ type: 'details' });
        expect(parseConfirmationIntent('say again', opts)).toEqual({ type: 'repeat' });
    });

    test('stop listening', () => {
        expect(parseConfirmationIntent('stop listening', opts)).toEqual({ type: 'stop_listening' });
        expect(parseConfirmationIntent('turn off voice', opts)).toEqual({ type: 'stop_listening' });
    });

    test('free-form utterances become guidance with original text', () => {
        const text = 'use the staging bucket instead';
        expect(parseConfirmationIntent(text, opts)).toEqual({ type: 'guidance', text });
    });

    test('"stop" alone is a decline, "stop listening" is not', () => {
        expect(parseConfirmationIntent('stop', opts)).toEqual({ type: 'decline' });
        expect(parseConfirmationIntent('stop listening', opts)).toEqual({ type: 'stop_listening' });
    });
});

describe('parseConfirmationIntent (question / ask_user)', () => {
    const opts = { isQuestion: true };

    test('a yes/no answer to a question is guidance, not approve/decline', () => {
        expect(parseConfirmationIntent('yes', opts)).toEqual({ type: 'guidance', text: 'yes' });
        expect(parseConfirmationIntent('no', opts)).toEqual({ type: 'guidance', text: 'no' });
    });

    test('free-form answer is guidance', () => {
        const text = 'the production database';
        expect(parseConfirmationIntent(text, opts)).toEqual({ type: 'guidance', text });
    });

    test('universal commands still work for questions', () => {
        expect(parseConfirmationIntent('stop listening', opts)).toEqual({ type: 'stop_listening' });
        expect(parseConfirmationIntent('repeat', opts)).toEqual({ type: 'repeat' });
    });
});
