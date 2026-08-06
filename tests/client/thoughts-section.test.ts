import { test, expect, describe } from 'bun:test';
import { getCollapsedPreviewThoughts } from '../../src/client/components/thoughts/ThoughtsSection';
import { getDelegatedConversationId } from '../../src/client/utils/formatting';
import { formatConversationHeader } from '../../src/shared';
import type { Thought } from '../../src/client/types';

describe('collapsed thoughts preview', () => {
    test('hides internal thinking', () => {
        const preview = getCollapsedPreviewThoughts([
            {
                id: 'thinking-1',
                type: 'thought',
                content: 'First line\n\nMost recent line',
                isInternalThought: true,
            },
        ]);

        expect(preview).toHaveLength(0);
    });

    test('does not show assistant-only messages without a tool step', () => {
        const message = '**Plan**\nRun the search before editing.';
        const preview = getCollapsedPreviewThoughts([
            {
                id: 'message-1',
                type: 'thought',
                content: message,
            },
        ]);

        expect(preview).toHaveLength(0);
    });

    test('keeps assistant messages and tool calls from the latest step only', () => {
        const toolCall: Thought = {
            id: 'tool-1',
            type: 'tool_call',
            content: '',
            toolName: 'list_files',
            toolArgs: { path: '.' },
            toolResult: '- src/\n- tests/',
            stepGroupId: 'step-2',
        };
        const secondToolCall: Thought = {
            id: 'tool-2',
            type: 'tool_call',
            content: '',
            toolName: 'view_file',
            toolArgs: { path: 'README.md' },
            toolResult: 'README contents',
            stepGroupId: 'step-2',
        };

        const preview = getCollapsedPreviewThoughts([
            {
                id: 'thinking-1',
                type: 'thought',
                content: 'Thinking',
                isInternalThought: true,
                stepGroupId: 'step-1',
            },
            {
                id: 'message-1',
                type: 'thought',
                content: 'Earlier step message.',
                stepGroupId: 'step-1',
            },
            {
                id: 'tool-0',
                type: 'tool_call',
                content: '',
                toolName: 'search_web',
                toolArgs: { query: 'earlier' },
                toolResult: 'Earlier result',
                stepGroupId: 'step-1',
            },
            {
                id: 'message-2',
                type: 'thought',
                content: 'I will inspect the workspace.',
                stepGroupId: 'step-2',
            },
            toolCall,
            secondToolCall,
        ]);

        expect(preview).toHaveLength(3);
        expect(preview[0]?.content).toBe('I will inspect the workspace.');
        expect(preview[1]?.type).toBe('tool_call');
        expect(preview[1]?.toolName).toBe('list_files');
        expect(preview[1]?.toolResult).toBeUndefined();
        expect(preview[2]?.type).toBe('tool_call');
        expect(preview[2]?.toolName).toBe('view_file');
        expect(preview[2]?.toolResult).toBeUndefined();
    });
});

describe('delegated conversation link', () => {
    const id = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';

    test('finds the conversation whether the task was backgrounded or waited on', () => {
        // Backgrounded delegation reports as JSON
        expect(getDelegatedConversationId('delegate_task', JSON.stringify({ status: 'started', conversation_id: id })))
            .toBe(id);
        // Delegation waited on in the foreground comes back as the inspect_task summary,
        // built by the server. Parsing what it actually writes is what keeps the two in step.
        expect(getDelegatedConversationId('delegate_task', `${formatConversationHeader(id)}\nTitle: Some task\nStatus: done`))
            .toBe(id);
    });

    test('offers no link when there is no task to open', () => {
        expect(getDelegatedConversationId('delegate_task', 'Error: Conversation not found')).toBeUndefined();
        expect(getDelegatedConversationId('delegate_task', undefined)).toBeUndefined();
        // Another tool naming a conversation is not a task this step started
        expect(getDelegatedConversationId('inspect_task', `Conversation: ${id}`)).toBeUndefined();
    });
});
