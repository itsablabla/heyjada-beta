import { test, expect, describe } from 'bun:test';
import {
    searchTools,
    buildSearchToolsDefinition,
    applyToolDeferral,
    applyProviderToolSearch,
    MCP_TOOL_DEFER_THRESHOLD,
    SEARCH_TOOLS_TOOL_NAME,
} from '../../src/server/processor/actor/search_tools';
import { toOpenaiTools, getFunctionCallName } from '../../src/server/processor/conversation/openai/utils';
import type { ToolDefinition } from '../../src/server/processor/conversation/conversation';

function makeTool(server: string, name: string, description: string): ToolDefinition {
    return {
        name: `${server}__${name}`,
        description: `[MCP: ${server}] ${description}`,
        schema: { type: 'object', properties: {} },
    };
}

const TOOLS: ToolDefinition[] = [
    makeTool('github', 'create_issue', 'Create a new issue in a GitHub repository'),
    makeTool('github', 'list_pull_requests', 'List pull requests in a repository'),
    makeTool('github', 'merge_pull_request', 'Merge an open pull request'),
    makeTool('linear', 'create_issue', 'Create a new issue in Linear'),
    makeTool('linear', 'search_issues', 'Search Linear issues by keyword'),
    makeTool('slack', 'send_message', 'Send a message to a Slack channel'),
];

describe('searchTools', () => {
    test('matches tools by substring pattern in name', () => {
        const result = searchTools({ query: 'issue' }, TOOLS);
        const names = result.matches.map(t => t.name);
        expect(names).toContain('github__create_issue');
        expect(names).toContain('linear__create_issue');
        expect(names).toContain('linear__search_issues');
        expect(names).not.toContain('slack__send_message');
        expect(result.compiled).toContain('github__create_issue');
    });

    test('matches tools by pattern in description', () => {
        const result = searchTools({ query: 'channel' }, TOOLS);
        expect(result.matches.map(t => t.name)).toEqual(['slack__send_message']);
    });

    test('supports regex wildcards', () => {
        const result = searchTools({ query: 'merge.*request' }, TOOLS);
        expect(result.matches.map(t => t.name)).toEqual(['github__merge_pull_request']);
    });

    test('supports regex alternation', () => {
        const result = searchTools({ query: 'channel|merge' }, TOOLS);
        const names = result.matches.map(t => t.name);
        expect(names).toContain('slack__send_message');
        expect(names).toContain('github__merge_pull_request');
        expect(names).toHaveLength(2);
    });

    test('restricts search to a server when specified', () => {
        const result = searchTools({ query: 'issue', server: 'linear' }, TOOLS);
        const names = result.matches.map(t => t.name);
        expect(names).toContain('linear__create_issue');
        expect(names.every(n => n.startsWith('linear__'))).toBe(true);
    });

    test('is case-insensitive', () => {
        const result = searchTools({ query: 'SLACK' }, TOOLS);
        expect(result.matches.map(t => t.name)).toContain('slack__send_message');
    });

    test('reports invalid regex with the parse error', () => {
        const result = searchTools({ query: '(unclosed' }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('Invalid regular expression');
    });

    test('rejects patterns over the length limit', () => {
        const result = searchTools({ query: 'a'.repeat(201) }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('exceeds 200 characters');
    });

    test('reports no matches gracefully', () => {
        const result = searchTools({ query: 'quantum_teleportation' }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('No tools matched');
    });

    test('handles empty query gracefully', () => {
        const result = searchTools({ query: '   ' }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('No search pattern');
    });

    test('tells the model matched tools are now available', () => {
        const result = searchTools({ query: 'slack' }, TOOLS);
        expect(result.compiled).toContain('now loaded');
    });
});

describe('buildSearchToolsDefinition', () => {
    test('indexes tool names grouped by server', () => {
        const definition = buildSearchToolsDefinition(TOOLS);
        expect(definition.name).toBe(SEARCH_TOOLS_TOOL_NAME);
        expect(definition.description).toContain('- github: create_issue, list_pull_requests, merge_pull_request');
        expect(definition.description).toContain('- linear: create_issue, search_issues');
        expect(definition.description).toContain('- slack: send_message');
        expect(definition.schema.required).toEqual(['query']);
    });
});

describe('applyToolDeferral', () => {
    const manyTools = Array.from({ length: MCP_TOOL_DEFER_THRESHOLD + 5 }, (_, i) =>
        makeTool('server', `tool_${i}`, `Tool number ${i}`)
    );

    test('passes all tools through below the threshold', () => {
        const few = TOOLS.slice(0, 3);
        const result = applyToolDeferral(few, new Set());
        expect(result).toEqual(few);
        expect(result.some(t => t.name === SEARCH_TOOLS_TOOL_NAME)).toBe(false);
    });

    test('defers all tools behind search_tools above the threshold', () => {
        const result = applyToolDeferral(manyTools, new Set());
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe(SEARCH_TOOLS_TOOL_NAME);
    });

    test('advertises loaded tools alongside search_tools', () => {
        const loaded = new Set(['server__tool_3', 'server__tool_7']);
        const result = applyToolDeferral(manyTools, loaded);
        expect(result.map(t => t.name)).toEqual([SEARCH_TOOLS_TOOL_NAME, 'server__tool_3', 'server__tool_7']);
    });

    test('provider: passes all tools through below the threshold', () => {
        const few = TOOLS.slice(0, 3);
        expect(applyProviderToolSearch(few)).toEqual(few);
        expect(applyProviderToolSearch(few, { namespaced: true })).toEqual(few);
    });

    test('provider: defers all tools with a provider tool_search entry above the threshold', () => {
        const result = applyProviderToolSearch(manyTools);
        expect(result[0]?.type).toBe('tool_search');
        expect(result).toHaveLength(manyTools.length + 1);
        expect(result.slice(1).every(t => t.deferLoading === true)).toBe(true);
    });

    test('provider namespaced: groups tools into one namespace per server', () => {
        const multiServer = [
            ...Array.from({ length: MCP_TOOL_DEFER_THRESHOLD }, (_, i) => makeTool('github', `tool_${i}`, `GitHub tool ${i}`)),
            makeTool('slack', 'send_message', 'Send a message to a Slack channel'),
        ];
        const result = applyProviderToolSearch(multiServer, {
            namespaced: true,
            serverDescriptions: new Map([['github', 'Manage GitHub repositories, issues and pull requests.']]),
        });

        expect(result[0]?.type).toBe('tool_search');
        const namespaces = result.filter(t => t.type === 'namespace');
        expect(namespaces.map(n => n.name)).toEqual(['github', 'slack']);
        // Configured server description is used; servers without one get a generic fallback
        expect(namespaces[0]?.description).toBe('Manage GitHub repositories, issues and pull requests.');
        expect(namespaces[1]?.description).toBe('Tools provided by the slack MCP server.');

        const github = namespaces[0]!;
        expect(github.tools).toHaveLength(MCP_TOOL_DEFER_THRESHOLD);
        // Children carry bare names, deferred schemas, and no redundant server prefix
        expect(github.tools?.[0]).toMatchObject({ name: 'tool_0', deferLoading: true, description: 'GitHub tool 0' });
        // Namespaces themselves are not deferred
        expect(namespaces.every(n => n.deferLoading === undefined)).toBe(true);
    });

    test('keeps the search_tools index stable as tools are loaded', () => {
        const before = applyToolDeferral(manyTools, new Set())[0]?.description;
        const after = applyToolDeferral(manyTools, new Set(['server__tool_3']))[0]?.description;
        expect(before).toBeDefined();
        expect(after).toBe(before!);
    });
});

describe('toOpenaiTools provider tool search mapping', () => {
    test('maps tool_search type to a provider tool_search tool', () => {
        const [mapped] = toOpenaiTools([{ name: 'tool_search', type: 'tool_search', schema: {} }]) ?? [];
        expect(mapped).toEqual({ type: 'tool_search' });
    });

    test('maps deferLoading to defer_loading on function tools', () => {
        const tool = makeTool('github', 'create_issue', 'Create an issue');
        const [mapped] = toOpenaiTools([{ ...tool, deferLoading: true }]) ?? [];
        expect(mapped).toMatchObject({ type: 'function', name: tool.name, defer_loading: true });
    });

    test('omits defer_loading on regular function tools', () => {
        const [mapped] = toOpenaiTools([makeTool('github', 'create_issue', 'Create an issue')]) ?? [];
        expect(mapped).toMatchObject({ type: 'function' });
        expect(mapped && 'defer_loading' in mapped).toBe(false);
    });

    test('maps namespace definitions with deferred children', () => {
        const [mapped] = toOpenaiTools([{
            type: 'namespace',
            name: 'github',
            description: 'Tools provided by the github MCP server.',
            schema: {},
            tools: [{ name: 'create_issue', description: 'Create an issue', schema: { type: 'object' }, deferLoading: true }],
        }]) ?? [];
        expect(mapped).toEqual({
            type: 'namespace',
            name: 'github',
            description: 'Tools provided by the github MCP server.',
            tools: [{
                type: 'function',
                name: 'create_issue',
                description: 'Create an issue',
                parameters: { type: 'object' },
                defer_loading: true,
            }],
        });
    });
});

describe('getFunctionCallName', () => {
    test('rejoins namespaced calls into the server__tool convention', () => {
        expect(getFunctionCallName({ name: 'create_issue', namespace: 'github' })).toBe('github__create_issue');
    });

    test('passes plain calls through unchanged', () => {
        expect(getFunctionCallName({ name: 'search_web' })).toBe('search_web');
        expect(getFunctionCallName({ name: 'github__create_issue', namespace: null })).toBe('github__create_issue');
    });
});
