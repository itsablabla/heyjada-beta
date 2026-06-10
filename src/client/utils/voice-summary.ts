/**
 * Build short, TTS-friendly spoken text from confirmation requests and run
 * results. Pure functions — no DOM — so they're easy to unit-test.
 *
 * Spoken prompts stay in English by design (LLM/voice-facing text, not UI).
 */

import type { ConfirmationRequest } from '../../server/processor/confirmation/confirmation.types';

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

/** A concise spoken description of a confirmation, read after the user's go-ahead. */
export function buildConfirmationSummary(req: ConfirmationRequest): string {
    // Questions (ask_user) are read verbatim; the user's reply is the answer.
    if (req.operation === 'ask_user') {
        return [req.title, req.message].filter(Boolean).join('. ');
    }

    const ctx = req.context;
    const parts: string[] = [req.title];

    if (ctx?.riskLevel === 'high') parts.push('This is a high-risk operation.');
    if (ctx?.operationType) parts.push(`Operation type: ${ctx.operationType}.`);
    if (ctx?.commandInfo?.command) parts.push(`Command: ${truncate(ctx.commandInfo.command, 120)}.`);

    const fileCount = ctx?.affectedFiles?.length ?? 0;
    if (fileCount === 1) parts.push(`Affects ${ctx!.affectedFiles![0]}.`);
    else if (fileCount > 1) parts.push(`Affects ${fileCount} files.`);
    else if (req.diff?.filePath) parts.push(`File: ${req.diff.filePath}.`);

    parts.push('Say yes to proceed, or no to decline.');
    return parts.filter(Boolean).join(' ');
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
    return `${stripMarkdown(cut)} … Open Pipali to read the full result.`;
}
