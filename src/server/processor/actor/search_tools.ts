/**
 * Tool Search Actor
 *
 * Lets the agent discover MCP tools on demand instead of loading every tool
 * schema into context upfront. When many MCP tools are connected, only a
 * compact name index is advertised (in this tool's description); the agent
 * searches by regex to load full tool definitions into its tool list.
 *
 * Mirrors the client-executed tool search pattern in the OpenAI Responses API
 * and Anthropic Messages API * (`tool_search(_tool_*)` + `defer_loading`).
 */

import type { ToolDefinition } from '../conversation/conversation';
import { parseNamespacedToolName } from '../mcp';

/**
 * Defer MCP tool schemas behind search when more than this many are connected.
 * Set above the default install's tool count (chrome-browser seeds 17 enabled
 * tools) so deferral only engages once additional servers are connected.
 */
export const MCP_TOOL_DEFER_THRESHOLD = 30;

export const SEARCH_TOOLS_TOOL_NAME = 'search_tools';

const MAX_SEARCH_RESULTS = 15;
const MAX_RESULT_DESCRIPTION_CHARS = 500;
const MAX_PATTERN_CHARS = 200;

export interface SearchToolsArgs {
    /** Regex pattern matched case-insensitively against tool names and descriptions */
    query: string;
    /** Restrict the search to tools from this MCP server */
    server?: string;
}

export interface SearchToolsResult {
    compiled: string;
    matches: ToolDefinition[];
}

/** Group namespaced tool names by server into a compact one-line-per-server index */
function buildToolIndex(mcpTools: ToolDefinition[]): string {
    const byServer = new Map<string, string[]>();
    for (const tool of mcpTools) {
        const parsed = parseNamespacedToolName(tool.name);
        const server = parsed?.serverName ?? 'other';
        const names = byServer.get(server) ?? [];
        names.push(parsed?.toolName ?? tool.name);
        byServer.set(server, names);
    }
    return Array.from(byServer.entries())
        .map(([server, names]) => `- ${server}: ${names.join(', ')}`)
        .join('\n');
}

/**
 * Build the search_tools ToolDefinition. The description carries a name-only
 * index of every deferrable tool, so the model knows what is discoverable
 * without paying for full schemas upfront. The index is built from the full
 * MCP tool set (not just unloaded tools) to keep the description stable
 * across iterations, preserving the prompt prefix cache.
 */
export function buildSearchToolsDefinition(mcpTools: ToolDefinition[]): ToolDefinition {
    return {
        name: SEARCH_TOOLS_TOOL_NAME,
        description: `Search the catalog of connected external (MCP) tools and load the ones you need.

Most external tools are not given to you upfront to keep your context lean. Search by regular expression to load their full definitions; matched tools become available to call from your next step onwards.

Tools available to discover, by server:
${buildToolIndex(mcpTools)}`,
        schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Regular expression matched case-insensitively against tool names and descriptions. Examples: "issue" substring, "create_.*_issue" wildcard, "issue|ticket|bug" alternation.',
                },
                server: {
                    type: 'string',
                    description: 'Optional. Restrict the search to tools from this server.',
                },
            },
            required: ['query'],
        },
    };
}

/** Regex search over MCP tool names and descriptions */
export function searchTools(args: SearchToolsArgs, mcpTools: ToolDefinition[]): SearchToolsResult {
    const pattern = (args.query ?? '').trim();
    if (!pattern) {
        return { compiled: 'No search pattern provided. Pass a regular expression to match against tool names and descriptions.', matches: [] };
    }
    if (pattern.length > MAX_PATTERN_CHARS) {
        return { compiled: `Search pattern exceeds ${MAX_PATTERN_CHARS} characters. Use a shorter regular expression.`, matches: [] };
    }

    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'i');
    } catch (error) {
        return {
            compiled: `Invalid regular expression "${pattern}": ${error instanceof Error ? error.message : String(error)}. Fix the pattern and search again.`,
            matches: [],
        };
    }

    const candidates = args.server
        ? mcpTools.filter(t => parseNamespacedToolName(t.name)?.serverName === args.server)
        : mcpTools;

    const allMatches = candidates.filter(tool => regex.test(`${tool.name} ${tool.description ?? ''}`));
    const matches = allMatches.slice(0, MAX_SEARCH_RESULTS);

    if (matches.length === 0) {
        const scope = args.server ? ` on server "${args.server}"` : '';
        return {
            compiled: `No tools matched /${args.query}/i${scope}. Try a broader pattern, or check the tool index in the search_tools description.`,
            matches: [],
        };
    }

    const listing = matches
        .map(tool => {
            const description = (tool.description ?? '').slice(0, MAX_RESULT_DESCRIPTION_CHARS);
            return `- ${tool.name}: ${description}`;
        })
        .join('\n');

    const omitted = allMatches.length - matches.length;
    const omittedNote = omitted > 0 ? `\n(${omitted} more matches omitted; refine the pattern to see them.)` : '';

    return {
        compiled: `Found ${matches.length} matching tool(s):\n${listing}${omittedNote}\n\nThese tools are now loaded and available to call from your next step.`,
        matches,
    };
}

/**
 * Provider-executed variant of tool deferral for models that support tool
 * search (OpenAI gpt-5.4+, Anthropic Claude via platform translation): all MCP
 * tools are sent marked defer_loading alongside a provider-native tool_search
 * tool. The provider hides deferred schemas from model context, executes
 * searches server-side (no app round-trip), and injects matches at the end of
 * context — deferral state rides in the conversation's raw item history.
 *
 * With `namespaced` (models with tool search over the OpenAI Responses API),
 * each MCP server becomes a namespace tool holding its tools as deferred
 * children, per the OpenAI tool search guidance — the model sees server names
 * and descriptions upfront and can load a whole server via one search. The
 * model then calls tools with a bare name plus a separate namespace field;
 * getFunctionCallName() rejoins them into the server__tool convention.
 */
export function applyProviderToolSearch(
    mcpTools: ToolDefinition[],
    options: { namespaced?: boolean; serverDescriptions?: Map<string, string> } = {}
): ToolDefinition[] {
    if (mcpTools.length <= MCP_TOOL_DEFER_THRESHOLD) {
        return mcpTools;
    }
    const searchTool: ToolDefinition = { name: 'tool_search', type: 'tool_search', schema: {} };
    if (!options.namespaced) {
        return [searchTool, ...mcpTools.map(tool => ({ ...tool, deferLoading: true }))];
    }

    // One namespace per MCP server; tools without a server prefix stay flat
    const byServer = new Map<string, ToolDefinition[]>();
    const flatTools: ToolDefinition[] = [];
    for (const tool of mcpTools) {
        const parsed = parseNamespacedToolName(tool.name);
        if (!parsed) {
            flatTools.push({ ...tool, deferLoading: true });
            continue;
        }
        const children = byServer.get(parsed.serverName) ?? [];
        children.push({
            name: parsed.toolName,
            // The [MCP: server] prefix is redundant inside the server's namespace
            description: tool.description?.replace(`[MCP: ${parsed.serverName}] `, ''),
            schema: tool.schema,
            deferLoading: true,
        });
        byServer.set(parsed.serverName, children);
    }

    const namespaces = Array.from(byServer.entries()).map(([server, tools]): ToolDefinition => ({
        type: 'namespace',
        name: server,
        description: options.serverDescriptions?.get(server) ?? `Tools provided by the ${server} MCP server.`,
        schema: {},
        tools,
    }));

    return [searchTool, ...namespaces, ...flatTools];
}

/**
 * Replace the full MCP tool list with the search_tools definition plus any
 * already-loaded tools. Below the threshold all tools pass through unchanged
 * and no search tool is advertised.
 */
export function applyToolDeferral(
    mcpTools: ToolDefinition[],
    loadedToolNames: Set<string>
): ToolDefinition[] {
    if (mcpTools.length <= MCP_TOOL_DEFER_THRESHOLD) {
        return mcpTools;
    }
    const loaded = mcpTools.filter(t => loadedToolNames.has(t.name));
    return [buildSearchToolsDefinition(mcpTools), ...loaded];
}
