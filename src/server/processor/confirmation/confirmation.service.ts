/**
 * Confirmation Service
 *
 * Handles user confirmation requests for dangerous operations.
 * Works with any frontend (web, TUI) through a callback-based system.
 */

import {
    type ConfirmationRequest,
    type ConfirmationResponse,
    type ConfirmationResult,
    type ConfirmationPreferences,
    type DiffInfo,
    type CommandExecutionInfo,
    type ConfirmationResponseAttachment,
    CONFIRMATION_OPTIONS,
    createStandardConfirmationOptions,
} from './confirmation.types';
import { scheduleConfirmationPush } from '../../push';

/**
 * How long an unanswered confirmation blocks its run before it is given up on.
 *
 * A run can be waiting while nobody is at the machine - a scheduled routine at 3am, or
 * a delegated task still going after the app was closed - so this is generous. Without
 * it those runs would block forever.
 */
export const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Callback function type for requesting confirmation from user
 * The implementer (WebSocket handler, TUI, etc.) provides this
 */
export type ConfirmationCallback = (request: ConfirmationRequest) => Promise<ConfirmationResponse>;

/**
 * Context for a confirmation-aware operation
 */
export interface ConfirmationContext {
    /** Callback to request confirmation from user */
    requestConfirmation: ConfirmationCallback;
    /** Current user preferences */
    preferences: ConfirmationPreferences;
    /** Session ID for tracking */
    sessionId?: string;
}

export async function requestConfirmationWithPush(
    context: ConfirmationContext,
    request: ConfirmationRequest
): Promise<ConfirmationResponse> {
    const scheduledPush = scheduleConfirmationPush(context.sessionId, request);
    try {
        return await context.requestConfirmation(request);
    } finally {
        scheduledPush.cancel();
    }
}

/**
 * Operations that require confirmation
 */
export type ConfirmableOperation =
    | 'edit_file'
    | 'write_file'
    | 'delete_file'
    | 'execute_command'
    | 'mcp_tool_call'
    | 'read_sensitive_file'
    | 'grep_sensitive_path'
    | 'fetch_internal_url';

/**
 * Get risk level based on operation and optional sub-type.
 * For shell commands: read-only = low, write-only = medium, read-write = high
 * For MCP tools: subType format is "serverName:safe" or "serverName:unsafe"
 */
function getRiskLevel(
    operation: ConfirmableOperation,
    operationSubType?: string
): 'low' | 'medium' | 'high' {
    // For execute_command, risk level depends on operation_type directly
    if (operation === 'execute_command' && operationSubType) {
        switch (operationSubType) {
            case 'read-only':
                return 'low';
            case 'write-only':
                return 'medium';
            case 'read-write':
                return 'high';
        }
    }

    // For mcp_tool_call, subType format is "serverName:safe" or "serverName:unsafe"
    if (operation === 'mcp_tool_call' && operationSubType) {
        if (operationSubType.endsWith(':safe')) {
            return 'low';
        }
        if (operationSubType.endsWith(':unsafe')) {
            return 'high';
        }
    }

    // Default risk levels for other operations
    const defaultRiskLevels: Record<ConfirmableOperation, 'low' | 'medium' | 'high'> = {
        edit_file: 'medium',
        write_file: 'medium',
        delete_file: 'high',
        execute_command: 'high',
        mcp_tool_call: 'medium',
        read_sensitive_file: 'medium',
        grep_sensitive_path: 'medium',
        fetch_internal_url: 'medium',
    };

    return defaultRiskLevels[operation];
}

function ensureQuestion(text: string): string {
    const firstSentence = text.trim().replace(/\s+/g, ' ').match(/^[^.!?]+[.!?]?/)?.[0] || text.trim();
    return `${firstSentence.replace(/[.!?]+$/, '')}?`;
}

function formatDisplayName(value: string): string {
    const normalized = value
        .split(/[\\/]/)
        .filter(Boolean)
        .at(-1) || value;

    return normalized || 'this file';
}

function formatMcpToolName(toolName: string): string {
    const serverName = toolName.includes('__') ? toolName.split('__')[0] : toolName;
    const normalized = (serverName || toolName)
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) return toolName;
    if (normalized.toLowerCase() === 'gmail') return 'your Gmail';

    return normalized.replace(/\b\w/g, c => c.toUpperCase());
}

function getReasonQuestion(reason?: string): string | undefined {
    const firstSentence = reason?.trim().replace(/\s+/g, ' ').match(/^[^.!?]+[.!?]?/)?.[0];
    if (!firstSentence || firstSentence.length > 120 || /[`$;&|<>]/.test(firstSentence)) {
        return undefined;
    }

    const phrase = firstSentence
        .replace(/[.!?]+$/, '')
        .replace(/^(i|we)\s+need\s+to\s+/i, '')
        .replace(/^need\s+to\s+/i, '')
        .replace(/^to\s+/i, '')
        .replace(/^this\s+(command\s+)?will\s+/i, '')
        .trim();

    if (!phrase) return undefined;

    return ensureQuestion(`Do you want to let Superjoy ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`);
}

function createConfirmationQuestion(
    operation: ConfirmableOperation,
    filePath: string,
    title: string,
    details: {
        toolName: string;
        commandInfo?: CommandExecutionInfo;
    }
): string {
    switch (operation) {
        case 'execute_command': {
            const reasonQuestion = getReasonQuestion(details.commandInfo?.reason);
            if (reasonQuestion) return reasonQuestion;

            const workdir = details.commandInfo?.workdir || filePath;
            return ensureQuestion(`Do you want to run a command in ${workdir || 'the terminal'}`);
        }
        case 'edit_file':
        case 'write_file':
            return ensureQuestion(`Do you want to let Superjoy edit ${formatDisplayName(filePath)}`);
        case 'delete_file':
            return ensureQuestion(`Do you want to let Superjoy delete ${formatDisplayName(filePath)}`);
        case 'read_sensitive_file':
            return ensureQuestion(`Do you want to let Superjoy read ${formatDisplayName(filePath)}`);
        case 'grep_sensitive_path':
            return ensureQuestion(`Do you want to let Superjoy search ${formatDisplayName(filePath)}`);
        case 'fetch_internal_url':
            return ensureQuestion('Do you want to let Superjoy access an internal network address');
        case 'mcp_tool_call':
            return ensureQuestion(`Do you want to let Superjoy use ${formatMcpToolName(details.toolName)}`);
        default:
            return ensureQuestion(title);
    }
}

/**
 * Create a new confirmation request for a file operation
 */
export function createFileOperationConfirmation(
    operation: ConfirmableOperation,
    filePath: string,
    details: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        additionalMessage?: string;
        diff?: DiffInfo;
        operationSubType?: string;
        /** Structured command execution info (for shell_command operations) */
        commandInfo?: CommandExecutionInfo;
    }
): ConfirmationRequest {
    const titles: Record<ConfirmableOperation, string> = {
        edit_file: 'Confirm File Edit',
        write_file: 'Confirm File Write',
        delete_file: 'Confirm File Deletion',
        execute_command: 'Confirm Command Execution',
        mcp_tool_call: 'Confirm Tool Call',
        read_sensitive_file: 'Confirm Sensitive File Access',
        grep_sensitive_path: 'Confirm Sensitive Path Search',
        fetch_internal_url: 'Confirm Internal Network Access',
    };
    const title = titles[operation];

    return {
        requestId: crypto.randomUUID(),
        inputType: 'choice',
        title,
        question: createConfirmationQuestion(operation, filePath, title, details),
        message: details.additionalMessage,
        operation,
        context: {
            toolName: details.toolName,
            toolArgs: details.toolArgs,
            // Only include affectedFiles for actual file operations, not MCP tool calls
            affectedFiles: operation === 'mcp_tool_call' ? [] : [filePath],
            riskLevel: getRiskLevel(operation, details.operationSubType),
            operationType: details.operationSubType,
            commandInfo: details.commandInfo,
        },
        diff: details.diff,
        options: createStandardConfirmationOptions(),
        defaultOptionId: CONFIRMATION_OPTIONS.NO,
        timeoutMs: 0, // No timeout - wait for user
    };
}

/**
 * Check if an operation requires confirmation
 * @param operationKey - Either a ConfirmableOperation or a composite key like "execute_command:read-only"
 */
export function requiresConfirmation(
    operationKey: string,
    preferences: ConfirmationPreferences
): boolean {
    return !preferences.skipConfirmationFor.has(operationKey);
}

export function formatConfirmationAttachmentBlock(attachments?: ConfirmationResponseAttachment[]): string {
    if (!attachments || attachments.length === 0) return '';

    const paths = attachments
        .map(attachment => attachment.path)
        .filter(path => typeof path === 'string' && path.trim().length > 0);

    if (paths.length === 0) return '';

    return `\n\n<attached_files>\n${paths.map(path => `- ${path}`).join('\n')}\n</attached_files>`;
}

/**
 * Process a confirmation response and return the result
 */
export function processConfirmationResponse(
    response: ConfirmationResponse
): ConfirmationResult {
    const approved = response.selectedOptionId === CONFIRMATION_OPTIONS.YES ||
        response.selectedOptionId === CONFIRMATION_OPTIONS.YES_DONT_ASK;

    const skipFutureConfirmations = response.selectedOptionId === CONFIRMATION_OPTIONS.YES_DONT_ASK;

    // Build denial reason, including guidance if provided
    let denialReason: string | undefined;
    if (!approved) {
        const attachmentBlock = formatConfirmationAttachmentBlock(response.attachments);
        if (response.selectedOptionId === CONFIRMATION_OPTIONS.GUIDANCE && response.guidance) {
            denialReason = `User denied the operation with guidance: ${response.guidance}${attachmentBlock}`;
        } else if (response.selectedOptionId === CONFIRMATION_OPTIONS.GUIDANCE && attachmentBlock) {
            denialReason = `User denied the operation with attachments:${attachmentBlock}`;
        } else {
            denialReason = `User denied the operation${attachmentBlock}`;
        }
    }

    return {
        approved,
        selectedOption: response.selectedOptionId,
        skipFutureConfirmations,
        denialReason,
    };
}

/**
 * Request confirmation for an operation
 *
 * @param operation - The type of operation
 * @param filePath - Path to the affected file
 * @param context - Confirmation context with callback and preferences
 * @param details - Additional details about the operation
 * @returns ConfirmationResult with approval status
 */
export async function requestOperationConfirmation(
    operation: ConfirmableOperation,
    filePath: string,
    context: ConfirmationContext,
    details: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        additionalMessage?: string;
        diff?: DiffInfo;
        /** Optional read/read-write sub-type for finer-grained confirmation tracking (used by shell_command) */
        operationSubType?: string;
        commandInfo?: CommandExecutionInfo;
    }
): Promise<ConfirmationResult> {
    // Build the confirmation key - includes sub-type if provided for finer-grained tracking
    // e.g., "execute_command:read-only" vs "execute_command:read-write"
    const confirmationKey = details.operationSubType
        ? `${operation}:${details.operationSubType}`
        : operation;

    // Check if user has opted to skip confirmations for this operation (or operation+subtype combo)
    if (!requiresConfirmation(confirmationKey, context.preferences)) {
        return {
            approved: true,
            selectedOption: CONFIRMATION_OPTIONS.YES_DONT_ASK,
            skipFutureConfirmations: true,
        };
    }

    // Create the confirmation request
    const request = createFileOperationConfirmation(operation, filePath, details);

    // Request confirmation from user via callback
    const response = await requestConfirmationWithPush(context, request);

    // Process the response
    const result = processConfirmationResponse(response);

    // Update preferences if user chose "don't ask again"
    // Store with the full key (including sub-type) for granular control
    if (result.skipFutureConfirmations) {
        context.preferences.skipConfirmationFor.add(confirmationKey);
    }

    return result;
}

/**
 * Create a new empty preferences object
 */
export function createEmptyPreferences(): ConfirmationPreferences {
    return {
        skipConfirmationFor: new Set(),
    };
}

/**
 * Serialize preferences for storage
 */
export function serializePreferences(preferences: ConfirmationPreferences): string {
    return JSON.stringify({
        skipConfirmationFor: Array.from(preferences.skipConfirmationFor),
    });
}

/**
 * Deserialize preferences from storage
 */
export function deserializePreferences(data: string): ConfirmationPreferences {
    try {
        const parsed = JSON.parse(data);
        return {
            skipConfirmationFor: new Set(parsed.skipConfirmationFor || []),
        };
    } catch {
        return createEmptyPreferences();
    }
}
