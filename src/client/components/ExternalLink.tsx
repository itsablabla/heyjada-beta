/**
 * Custom link component that opens external URLs in the system's default browser
 * and file:// URLs with the system's default application.
 * Used with ReactMarkdown to ensure links don't navigate within the WebView.
 */

import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { openInBrowser, openFile, isTauri } from '../utils/tauri';

type ExternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
    node?: unknown;
};

/**
 * Link component that opens URLs externally (in system browser) when in desktop mode,
 * and opens file:// URLs with the system's default application.
 * For use as a custom component in ReactMarkdown.
 */
export function ExternalLink({ href, children, node: _node, ...props }: ExternalLinkProps) {
    const isFileHref = href?.startsWith('file://');
    const isHttpHref = href?.startsWith('http://') || href?.startsWith('https://');
    const inTauri = isTauri();

    const handleMouseDown = (e: MouseEvent<HTMLAnchorElement>) => {
        if (!inTauri) return;
        if (!isFileHref) return;
        e.preventDefault();
        e.stopPropagation();
    };

    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
        // Handle file:// URLs - open with system default app
        if (inTauri && isFileHref && href) {
            e.preventDefault();
            e.stopPropagation();
            // Ensure nothing else in the page reacts to this click.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (e.nativeEvent as any)?.stopImmediatePropagation?.();

            void openFile(href);
            return;
        }

        // Handle external links (http/https)
        if (isHttpHref && href) {
            if (inTauri) {
                // Tauri: open in the system browser via the shell-open/opener API
                e.preventDefault();
                e.stopPropagation();
                void openInBrowser(href);
                return;
            }
            // Web: let the browser handle it via target="_blank" so the app
            // never navigates away from the running conversation.
            e.stopPropagation();
            return;
        }
        // Let other links (like anchors) work normally
    };

    // For file:// URLs, show a visual cue that it's a file link (only in Tauri)
    const linkProps = isFileHref && inTauri
        ? { ...props, title: props.title || 'Open with default application' }
        : props;

    // External links always open in a new tab and never carry an opener reference
    const externalProps = isHttpHref
        ? { target: '_blank', rel: 'noopener noreferrer' }
        : {};

    return (
        <a {...linkProps} {...externalProps} href={href} onMouseDown={handleMouseDown} onClick={handleClick}>
            {children}
        </a>
    );
}
