import { test, expect, describe } from 'bun:test';
import { buildConfirmationSummary, buildCompletionSummary, COMPLETION_SPEAK_CAP } from '../../src/client/utils/voice-summary';
import type { ConfirmationRequest } from '../../src/server/processor/confirmation/confirmation.types';

function req(partial: Partial<ConfirmationRequest>): ConfirmationRequest {
    return {
        requestId: 'r1',
        inputType: 'choice',
        title: 'Run a command',
        operation: 'shell_command',
        options: [],
        ...partial,
    };
}

describe('buildConfirmationSummary', () => {
    test('reads a question verbatim for ask_user', () => {
        const r = req({ operation: 'ask_user', title: 'Which environment?', message: 'staging or production?' });
        expect(buildConfirmationSummary(r)).toBe('Which environment?. staging or production?');
    });

    test('includes risk, command, and file count, then a yes/no prompt', () => {
        const r = req({
            title: 'Delete build artifacts',
            context: {
                toolName: 'shell_command',
                toolArgs: {},
                riskLevel: 'high',
                operationType: 'write',
                commandInfo: { command: 'rm -rf dist', reason: 'clean', workdir: '/x' },
                affectedFiles: ['a', 'b', 'c'],
            },
        });
        const out = buildConfirmationSummary(r);
        expect(out).toContain('high-risk');
        expect(out).toContain('rm -rf dist');
        expect(out).toContain('Affects 3 files');
        expect(out).toContain('Say yes to proceed, or no to decline.');
    });

    test('names a single affected file', () => {
        const r = req({ context: { toolName: 't', toolArgs: {}, affectedFiles: ['/etc/hosts'] } });
        expect(buildConfirmationSummary(r)).toContain('Affects /etc/hosts');
    });
});

describe('buildCompletionSummary', () => {
    test('speaks short responses in full (markdown stripped)', () => {
        expect(buildCompletionSummary('# Done\nAll **good**.')).toBe('Done All good.');
    });

    test('empty response has a spoken fallback', () => {
        expect(buildCompletionSummary('')).toBe('The task finished with no text response.');
    });

    // Filler longer than the cap forces truncation regardless of the cap value.
    const OVERFLOW = COMPLETION_SPEAK_CAP + 200;

    test('long responses are trimmed with a pointer to the full result', () => {
        const long = 'First paragraph. ' + 'x'.repeat(OVERFLOW) + '\n\nSecond paragraph.';
        const out = buildCompletionSummary(long);
        expect(out).toContain('First paragraph.');
        expect(out).toContain('Open Pipali to read the full result.');
        expect(out).not.toContain('Second paragraph.');
    });

    test('caps at a paragraph break within the limit', () => {
        const text = 'Para one is short.\n\n' + 'y'.repeat(OVERFLOW);
        const out = buildCompletionSummary(text);
        expect(out).toBe('Para one is short. … Open Pipali to read the full result.');
        expect(out).not.toContain('y');
    });

    test('caps at a sentence end, not mid-word', () => {
        const text = 'Alpha. Beta. ' + 'z'.repeat(OVERFLOW);
        const out = buildCompletionSummary(text);
        expect(out).toBe('Alpha. Beta. … Open Pipali to read the full result.');
        expect(out).not.toContain('z');
    });
});
