import type { ToolDefinition } from "../conversation";
import type { Responses } from 'openai/resources/responses/responses';

export function toOpenaiTools(tools?: ToolDefinition[]): Responses.Tool[] | undefined {
    if (!tools) return undefined;
    return tools.map((tool): Responses.Tool => {
        if (tool.type === 'tool_search') {
            // Provider executes searches over tools marked defer_loading
            return { type: 'tool_search' };
        }
        if (tool.type === 'namespace') {
            return {
                type: 'namespace',
                name: tool.name,
                description: tool.description ?? '',
                tools: (tool.tools ?? []).map((child) => ({
                    type: 'function' as const,
                    name: child.name,
                    description: child.description ?? undefined,
                    parameters: child.schema,
                    ...(child.deferLoading ? { defer_loading: true } : {}),
                })),
            };
        }
        return {
            type: 'function' as const,
            name: tool.name,
            description: tool.description ?? undefined,
            parameters: tool.schema,
            strict: false,
            ...(tool.deferLoading ? { defer_loading: true } : {}),
        };
    });
}

/**
 * Resolve a function call's effective tool name. Calls to tools inside a
 * namespace carry a bare function name plus a separate namespace field;
 * rejoin them into the app's server__tool naming convention for routing.
 */
export function getFunctionCallName(call: { name: string; namespace?: string | null }): string {
    return call.namespace ? `${call.namespace}__${call.name}` : call.name;
}

/**
 * Get the reasoning content as a string from a Responses API reasoning object.
 * Returns undefined if no reasoning is present.
 */
export function getReasoningText(reasoning: Responses.ResponseReasoningItem | undefined): string | undefined {
    if (!reasoning?.summary || reasoning.summary.length === 0) {
        return undefined;
    }
    return reasoning.summary.map(s => s.text).join('\n\n');
}
