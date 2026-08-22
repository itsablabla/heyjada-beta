/**
 * Read Webpage Actor Tool
 *
 * Reads and extracts content from web pages.
 * Tries the Superjoy Platform scraper first, falls back to direct URL fetch.
 * Uses LLM to extract relevant information from raw content on direct fetch.
 */

import { platformFetch } from '../../http/platform-fetch';
import { getPlatformUrl } from '../../auth';
import { extractRelevantContent, truncateWebpageContent } from './webpage_extractor';
import type { MetricsAccumulator } from '../director/types';
import { isInternalUrl, getInternalUrlReason } from '../../security';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'read_webpage' });

// Timeout for webpage fetch requests (in milliseconds)
const FETCH_REQUEST_TIMEOUT = 60000;

// User agent for direct URL fetching
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Arguments for the read_webpage tool
 */
export interface ReadWebpageArgs {
    /** The URL of the webpage to read */
    url: string;
    /** The query/question to extract relevant information for */
    query?: string;
    /** Bypass the scraper cache and fetch a live copy of the page */
    fresh?: boolean;
}

/**
 * Result from read_webpage tool
 */
export interface ReadWebpageResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Options for webpage reading operations
 */
export interface ReadWebpageOptions {
    /** Confirmation context for requesting user approval on internal URLs */
    confirmationContext?: ConfirmationContext;
    /** Metrics accumulator for tracking LLM usage */
    metricsAccumulator?: MetricsAccumulator;
}

/**
 * Read webpage content using Superjoy Platform API
 * Uses platformFetch for automatic token refresh on 401 errors
 */
async function readWithPlatform(
    url: string,
    query: string | undefined,
    fresh: boolean | undefined,
    conversationId?: string,
    runId?: string,
): Promise<string | null> {
    const endpoint = `${getPlatformUrl()}/tools/read-webpage`;

    const payload: { url: string; query?: string; fresh?: boolean } = { url };
    if (query) {
        payload.query = query;
    }
    if (fresh) {
        payload.fresh = true;
    }

    log.debug(`Read using Superjoy Platform: ${url}${fresh ? ' (fresh)' : ''}`);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (conversationId) headers['X-Pipali-Conversation-ID'] = conversationId;
    if (runId) headers['X-Pipali-Run-ID'] = runId;

    const result = await platformFetch<{ content?: string; title?: string; url: string }>(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: FETCH_REQUEST_TIMEOUT,
    });

    if (!result.data.content) {
        return null;
    }

    if (result.wasRetried) {
        log.debug('Platform request succeeded after token refresh');
    }

    return result.data.content;
}

/**
 * Read webpage content using direct URL fetch
 * Fetches HTML/JSON and converts to text
 */
async function readWithDirectFetch(url: string, fresh?: boolean): Promise<string | null> {
    log.debug(`Reading with direct fetch: ${url}${fresh ? ' (fresh)' : ''}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_REQUEST_TIMEOUT);

    try {
        const headers: Record<string, string> = {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        };
        if (fresh) {
            headers['Cache-Control'] = 'no-cache';
            headers['Pragma'] = 'no-cache';
        }
        const response = await fetch(url, {
            headers,
            signal: controller.signal,
            redirect: 'follow',
            ...(fresh ? { cache: 'no-store' as RequestCache } : {}),
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
            return await response.text();
        }

        if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
            throw new Error(`Unsupported content type: ${contentType}`);
        }

        const html = await response.text();
        return htmlToText(html);
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('Webpage fetch timed out');
        }
        throw error;
    }
}

/**
 * Simple HTML to text conversion
 * Strips HTML tags and extracts text content
 */
function htmlToText(html: string): string {
    // Remove script and style elements
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // Replace common block elements with newlines
    text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi, '\n');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    text = text.replace(/&nbsp;/gi, ' ');
    text = text.replace(/&amp;/gi, '&');
    text = text.replace(/&lt;/gi, '<');
    text = text.replace(/&gt;/gi, '>');
    text = text.replace(/&quot;/gi, '"');
    text = text.replace(/&#39;/gi, "'");
    text = text.replace(/&apos;/gi, "'");

    // Normalize whitespace
    text = text.replace(/\t/g, ' ');
    text = text.replace(/ +/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n\n');
    text = text.trim();

    // Truncate overlong content to avoid overwhelming the context
    text = truncateWebpageContent(text);
    return text;
}

/**
 * Validate URL format
 */
function isValidUrl(urlString: string): boolean {
    try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Main read_webpage function
 *
 * Tries Superjoy Platform scraper. Fallback to local, direct URL fetch.
 * Use LLM to process raw webpage content.
 *
 * Security: Internal/private network URLs require user confirmation.
 */
export async function readWebpage(
    args: ReadWebpageArgs,
    options?: ReadWebpageOptions | MetricsAccumulator,
    conversationId?: string,
    runId?: string,
): Promise<ReadWebpageResult> {
    const { url, query, fresh } = args;

    // Handle both old signature (metricsAccumulator) and new signature (options object)
    const opts: ReadWebpageOptions = options && 'confirmationContext' in options
        ? options
        : { metricsAccumulator: options as MetricsAccumulator | undefined };

    if (!url || url.trim().length === 0) {
        return {
            query: 'Read webpage',
            file: '',
            uri: '',
            compiled: 'Error: URL is required',
        };
    }

    if (!isValidUrl(url)) {
        return {
            query: `**Reading webpage**: ${url}`,
            file: url,
            uri: url,
            compiled: 'Error: Invalid URL format. URL must start with http:// or https://',
        };
    }

    // Check if URL points to internal/private network and request confirmation
    if (isInternalUrl(url) && opts.confirmationContext) {
        const reason = getInternalUrlReason(url) || 'internal network resource';
        const confirmResult = await requestOperationConfirmation(
            'fetch_internal_url',
            url,
            opts.confirmationContext,
            {
                toolName: 'read_webpage',
                toolArgs: { url, query },
                additionalMessage: `This URL points to a ${reason}.\n\nInternal network resources may expose sensitive information. Are you sure you want to access this URL?`,
            }
        );

        if (!confirmResult.approved) {
            return {
                query: `**Reading webpage**: ${url}`,
                file: url,
                uri: url,
                compiled: `Webpage fetch cancelled: ${confirmResult.denialReason || 'User denied access to internal network URL'}`,
            };
        }
    }

    try {
        let rawContent: string | null = null;
        let usedPlatform = false;

        // Try platform scraper first
        try {
            rawContent = await readWithPlatform(url, query, fresh, conversationId, runId);
            if (rawContent) usedPlatform = true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`Platform scraper failed: ${message}`);
        }

        // Fall back to direct URL fetch
        if (!rawContent) {
            try {
                rawContent = await readWithDirectFetch(url, fresh);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.warn(`Direct fetch failed: ${message}`);

                return {
                    query: `**Reading webpage**: ${url}`,
                    file: url,
                    uri: url,
                    compiled: `Failed to read webpage. Error: ${message}`,
                };
            }
        }

        if (!rawContent) {
            return {
                query: `**Reading webpage**: ${url}`,
                file: url,
                uri: url,
                compiled: 'Failed to read webpage content.',
            };
        }

        log.debug(`Got ${rawContent.length} chars from ${usedPlatform ? 'platform' : 'direct fetch'}`);

        // Platform already extracts relevant content server-side.
        // For direct fetch, use LLM extraction if a query is provided.
        let extractedContent: string;
        if (!usedPlatform) {
            try {
                log.debug(`Extracting relevant content for query: "${query}"`);
                extractedContent = await extractRelevantContent(rawContent, query ?? '', url, opts.metricsAccumulator);
                log.debug(`Extracted ${extractedContent.length} chars of relevant content`);
            } catch (error) {
                log.warn(`Content extraction failed, using raw content: ${error}`);
            }
        }

        // Fallback to truncated raw content if extraction fails
        extractedContent ??= truncateWebpageContent(rawContent);

        return {
            query: `**Reading webpage**: ${url}`,
            file: url,
            uri: url,
            compiled: extractedContent,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Error: ${errorMessage}`);

        return {
            query: `**Reading webpage**: ${url}`,
            file: url,
            uri: url,
            compiled: `Error reading webpage: ${errorMessage}`,
        };
    }
}
