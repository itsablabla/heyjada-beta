/**
 * Build short, TTS-friendly spoken text from confirmation requests and run
 * results. Pure functions — no DOM — so they're easy to unit-test.
 *
 * Spoken prompts stay in English by design (LLM/voice-facing text, not UI).
 */

import type { ConfirmationRequest } from '../../../server/processor/confirmation/confirmation.types';

export const COMPLETION_SPEAK_CAP = 1000;

/** Strip common markdown so a TTS engine reads it naturally. */
function stripMarkdown(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, ' code block ')    // fenced code
        .replace(/`([^`]+)`/g, '$1')                   // inline code
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' image ')   // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // links → text
        .replace(/^#{1,6}\s+/gm, '')                   // headings
        .replace(/[*_>#]/g, '')                        // residual emphasis/quote marks
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/** "github__create_issue" → "github create issue" for the ear. */
function humanizeToolName(name: string): string {
    return name.replace(/[_-]+/g, ' ').trim();
}

/** Max parent folders spoken; deeper prefixes add noise, not orientation. */
const SPOKEN_PATH_DEPTH = 3;

/**
 * Render a path the way you'd say it: file name first, then the nearest
 * folders — "Tasks.org under the Documents/Notes folder". Home-directory
 * prefixes carry no information aloud and are dropped.
 */
export function speakablePath(path: string): string {
    const stripped = path
        .replace(/\\/g, '/')
        .replace(/^[A-Za-z]:\//, '/')
        .replace(/^~\//, '')
        .replace(/^\/(?:Users|home)\/[^/]+\//, '')
        .replace(/^\//, '');
    const segments = stripped.split('/').filter(Boolean);
    if (segments.length === 0) return path;
    const name = segments[segments.length - 1]!;
    const dirs = segments.slice(0, -1).slice(-SPOKEN_PATH_DEPTH);
    return dirs.length ? `${name} under the ${dirs.join('/')} folder` : name;
}

/**
 * The operation as a spoken verb phrase completing "Superjoy wants to …".
 * The shell command itself is never spoken — syntax is unfollowable by ear
 * (the dialog shows it exactly); the agent's justification carries the intent.
 */
function intentPhrase(req: ConfirmationRequest): string | null {
    const ctx = req.context;
    const rawPath = ctx?.affectedFiles?.[0] ?? req.diff?.filePath;
    const file = rawPath ? speakablePath(rawPath) : undefined;
    switch (req.operation) {
        case 'edit_file': return file ? `edit ${file}` : 'edit a file';
        case 'write_file':
            if (req.diff?.isNewFile) return file ? `create ${file}` : 'create a file';
            return file ? `overwrite ${file}` : 'overwrite a file';
        case 'delete_file': return file ? `delete ${file}` : 'delete a file';
        case 'execute_command': {
            const mode = ctx?.operationType === 'read-only' || ctx?.operationType === 'read-write'
                ? `a ${ctx.operationType}` : 'a';
            const reason = ctx?.commandInfo?.reason?.replace(/^to\s+/i, '');
            return `run ${mode} shell command${reason ? ` to ${truncate(reason, 200)}` : ''}`;
        }
        case 'mcp_tool_call':
            return ctx?.toolName ? `use the ${humanizeToolName(ctx.toolName)} tool` : 'call an external tool';
        case 'read_sensitive_file': return file ? `read a sensitive file, ${file}` : 'read a sensitive file';
        case 'grep_sensitive_path': return file ? `search a sensitive location, ${file}` : 'search a sensitive location';
        case 'fetch_internal_url': return 'fetch an internal network address';
        default: return null;
    }
}

/**
 * A concise spoken description of a confirmation. One natural intent sentence
 * — "Superjoy wants to edit X." — then the deterministic facts (risk, file
 * count) as follow-ons; `spokenDetail` (the fast model's description of what
 * the change does, when available) is woven in before the decision trailer.
 */
export function buildConfirmationSummary(req: ConfirmationRequest, spokenDetail?: string): string {
    // Questions (ask_user) are read verbatim; the user's reply is the answer.
    if (req.operation === 'ask_user') {
        return [req.title, req.message].filter(Boolean).join('. ');
    }

    const ctx = req.context;
    const intent = intentPhrase(req);
    const parts: string[] = [intent ? `Superjoy wants to ${intent}.` : req.title];
    if (ctx?.riskLevel === 'high') parts.push('This is a high-risk operation.');
    const fileCount = ctx?.affectedFiles?.length ?? 0;
    if (fileCount > 1) parts.push(`Affects ${fileCount} files.`);
    if (spokenDetail) parts.push(spokenDetail);
    parts.push('Say yes to proceed, or no to decline.');
    return parts.filter(Boolean).join(' ');
}

/** Per-side cap for diff text sent to the action summarizer — one spoken sentence needs the gist, not the whole diff. */
const DETAIL_SIDE_CAP = 4000;

/**
 * The raw content behind a confirmation as material for the action summarizer.
 * Only edits and external tool calls need it — a diff or a JSON args blob has
 * no spoken form of its own. Shell commands return null: the agent's required
 * `justification` is already spoken in the mechanical frame, so a second model
 * pass would only re-derive it (detect at the cheapest layer). Questions never
 * get a detail: they are read verbatim.
 */
export function buildConfirmationDetail(req: ConfirmationRequest): string | null {
    if (req.operation === 'ask_user') return null;
    if (req.context?.commandInfo?.command) return null;

    // MCP confirmations carry no message or justification — the tool name and
    // its arguments are the only content there is to describe.
    if (req.operation === 'mcp_tool_call' && req.context?.toolName) {
        return [
            `External tool call: ${req.context.toolName}`,
            `Arguments:\n${JSON.stringify(req.context.toolArgs ?? {}).slice(0, DETAIL_SIDE_CAP)}`,
        ].join('\n\n');
    }

    const diff = req.diff;
    if (diff && (diff.oldText || diff.newText)) {
        // No oldText and not a new file = write_file replacing the whole file —
        // name that plainly so the summarizer can't soften it into an "edit".
        const action = diff.isNewFile ? 'Create file'
            : diff.oldText ? 'Edit file'
            : 'Overwrite entire file (existing content is replaced)';
        return [
            `${action}: ${diff.filePath}`,
            diff.oldText ? `Text being replaced:\n${diff.oldText.slice(0, DETAIL_SIDE_CAP)}` : '',
            diff.newText ? `New text:\n${diff.newText.slice(0, DETAIL_SIDE_CAP)}` : '',
        ].filter(Boolean).join('\n\n');
    }

    // Other operations (e.g. MCP tools): the detailed message is the content.
    return req.message?.trim() || null;
}

/** A spoken summary of a completed run: the full response if short, else cut at the nearest natural break. */
export function buildCompletionSummary(response: string): string {
    const trimmed = (response || '').trim();
    if (!trimmed) return 'The task finished with no text response.';
    if (trimmed.length <= COMPLETION_SPEAK_CAP) return stripMarkdown(trimmed);

    // Cut at the last natural break (paragraph or sentence end) within the cap so
    // speech ends on a complete thought. Detected on the raw text — paragraph
    // breaks still exist here, since stripMarkdown collapses them to spaces.
    const window = trimmed.slice(0, COMPLETION_SPEAK_CAP);
    const naturalEnd = Math.max(
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
    );
    const cut = naturalEnd > 0 ? window.slice(0, naturalEnd + 1) : window;
    return `${stripMarkdown(cut)} … Open Superjoy to read the full result.`;
}
