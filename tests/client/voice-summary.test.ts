import { test, expect, describe } from 'bun:test';
import { buildConfirmationSummary, buildConfirmationDetail, buildCompletionSummary, speakablePath, COMPLETION_SPEAK_CAP } from '../../src/client/utils/voice/voice-summary';
import type { ConfirmationRequest } from '../../src/server/processor/confirmation/confirmation.types';

// Defaults mirror a real shell confirmation: the runtime operation is
// 'execute_command' (the ConfirmableOperation), which phrasing keys on.
function req(partial: Partial<ConfirmationRequest>): ConfirmationRequest {
    return {
        requestId: 'r1',
        inputType: 'choice',
        title: 'Confirm Command Execution',
        operation: 'execute_command',
        options: [],
        ...partial,
    };
}

describe('buildConfirmationSummary', () => {
    test('reads a question verbatim for ask_user', () => {
        const r = req({ operation: 'ask_user', title: 'Which environment?', message: 'staging or production?' });
        expect(buildConfirmationSummary(r)).toBe('Which environment?. staging or production?');
    });

    test('shell commands read as one intent sentence, with risk and file count as follow-ons', () => {
        const r = req({
            context: {
                toolName: 'shell_command',
                toolArgs: {},
                riskLevel: 'high',
                operationType: 'read-write',
                commandInfo: { command: 'rm -rf dist', reason: 'clean the build directory', workdir: '/x' },
                affectedFiles: ['a', 'b', 'c'],
            },
        });
        const out = buildConfirmationSummary(r);
        expect(out).toContain('Super Joy wants to run a read-write shell command to clean the build directory.');
        expect(out).toContain('high-risk');
        expect(out).toContain('Affects 3 files');
        expect(out).toContain('Say yes to proceed, or no to decline.');
        expect(out).not.toContain('rm -rf dist');    // syntax is never spoken
    });

    test('a justification already starting with "to" is not doubled', () => {
        const r = req({
            context: {
                toolName: 'shell_command', toolArgs: {},
                commandInfo: { command: 'git push', reason: 'To publish the commits', workdir: '/r' },
            },
        });
        expect(buildConfirmationSummary(r)).toContain('shell command to publish the commits.');
    });

    test('edits name the file in spoken form', () => {
        const r = req({ operation: 'edit_file', context: { toolName: 'edit_file', toolArgs: {}, affectedFiles: ['/Users/alex/Documents/Notes/Tasks.org'] } });
        expect(buildConfirmationSummary(r)).toContain('Super Joy wants to edit Tasks.org under the Documents/Notes folder.');
    });

    test('mcp tool calls speak the humanized tool name', () => {
        const r = req({
            operation: 'mcp_tool_call', title: 'Confirm Tool Call',
            context: { toolName: 'github__create_issue', toolArgs: { title: 'Bug' } },
        });
        expect(buildConfirmationSummary(r)).toContain('Super Joy wants to use the github create issue tool.');
    });

    test('weaves the spoken detail in before the decision trailer', () => {
        const r = req({ operation: 'edit_file', diff: { filePath: '/a/b.ts', newText: 'x' } });
        const out = buildConfirmationSummary(r, 'It adds a retry to the fetch call.');
        expect(out.indexOf('It adds a retry')).toBeGreaterThan(out.indexOf('b.ts'));
        expect(out.indexOf('It adds a retry')).toBeLessThan(out.indexOf('Say yes to proceed'));
    });
});

describe('speakablePath', () => {
    test('drops the home prefix and reads name-first', () => {
        expect(speakablePath('/Users/alex/Documents/Notes/Tasks.org'))
            .toBe('Tasks.org under the Documents/Notes folder');
        expect(speakablePath('~/Documents/plan.md')).toBe('plan.md under the Documents folder');
        expect(speakablePath('C:\\Users\\alex\\Documents\\plan.md')).toBe('plan.md under the Documents folder');
    });

    test('caps deep paths at the nearest folders', () => {
        expect(speakablePath('/home/alex/code/pipali/src/client/utils/voice/voice-summary.ts'))
            .toBe('voice-summary.ts under the client/utils/voice folder');
    });

    test('bare and root-level files are just the name', () => {
        expect(speakablePath('notes.md')).toBe('notes.md');
        expect(speakablePath('/Users/alex/notes.md')).toBe('notes.md');
    });
});

describe('buildConfirmationDetail', () => {
    test('questions never get a model detail — they are read verbatim', () => {
        expect(buildConfirmationDetail(req({ operation: 'ask_user', message: 'Which env?' }))).toBeNull();
    });

    test('shell commands get no model detail — the justification is spoken mechanically', () => {
        const r = req({
            message: 'Run git push',
            context: {
                toolName: 'shell_command', toolArgs: {},
                commandInfo: { command: 'git push origin main', reason: 'publish commits', workdir: '/repo' },
            },
        });
        expect(buildConfirmationDetail(r)).toBeNull();
    });

    test('edits carry both sides of the diff, labeled', () => {
        const r = req({ operation: 'edit_file', diff: { filePath: '/a.ts', oldText: 'const x = 1', newText: 'const x = 2' } });
        const detail = buildConfirmationDetail(r)!;
        expect(detail).toContain('Edit file: /a.ts');
        expect(detail).toContain('Text being replaced:\nconst x = 1');
        expect(detail).toContain('New text:\nconst x = 2');
    });

    test('writes distinguish create from whole-file overwrite', () => {
        const create = req({ operation: 'write_file', diff: { filePath: '/n.ts', newText: 'hi', isNewFile: true } });
        expect(buildConfirmationDetail(create)).toContain('Create file: /n.ts');
        const overwrite = req({ operation: 'write_file', diff: { filePath: '/n.ts', newText: 'hi', isNewFile: false } });
        expect(buildConfirmationDetail(overwrite)).toContain('Overwrite entire file');
    });

    test('mcp tool calls feed the tool name and arguments to the summarizer', () => {
        const r = req({
            operation: 'mcp_tool_call',
            context: { toolName: 'github__create_issue', toolArgs: { title: 'Voice beta feedback' } },
        });
        const detail = buildConfirmationDetail(r)!;
        expect(detail).toContain('github__create_issue');
        expect(detail).toContain('Voice beta feedback');
    });

    test('content-less requests fall back to the message', () => {
        expect(buildConfirmationDetail(req({ message: 'Calls the GitHub API to open an issue.' })))
            .toBe('Calls the GitHub API to open an issue.');
        expect(buildConfirmationDetail(req({}))).toBeNull();
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
        expect(out).toContain('Open Super Joy to read the full result.');
        expect(out).not.toContain('Second paragraph.');
    });

    test('caps at a paragraph break within the limit', () => {
        const text = 'Para one is short.\n\n' + 'q'.repeat(OVERFLOW);
        const out = buildCompletionSummary(text);
        expect(out).toBe('Para one is short. … Open Super Joy to read the full result.');
        expect(out).not.toContain('q');
    });

    test('caps at a sentence end, not mid-word', () => {
        const text = 'Alpha. Beta. ' + 'z'.repeat(OVERFLOW);
        const out = buildCompletionSummary(text);
        expect(out).toBe('Alpha. Beta. … Open Super Joy to read the full result.');
        expect(out).not.toContain('z');
    });
});
