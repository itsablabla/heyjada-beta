/**
 * Shared server-rendered status page for browser-based OAuth callbacks.
 *
 * Rendered in the system browser (not the React app), so it can't use the
 * design system directly — instead it mirrors the app's design tokens as CSS
 * variables (light + dark) to feel like a trusted, native part of Superjoy.
 *
 * On success it can auto-foreground the desktop app via a `pipali://` deep
 * link (the same UX pattern as VS Code), with a manual button as fallback.
 */

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]!));
}

/**
 * Design-system CSS for status pages. Inlines a snapshot of the design tokens
 * it uses (mirrors src/client/styles/tokens/) so these browser-rendered pages
 * stay standalone — no app bundle needed.
 */
function getStatusPageStyles(): string {
    return `
        :root {
            --color-bg: #fafafa;
            --color-bg-elevated: #ffffff;
            --color-text: #1a1a1a;
            --color-text-secondary: #525252;
            --color-text-muted: #a3a3a3;
            --color-border: #e5e5e5;
            --color-accent: #1a1a1a;
            --color-success: #22c55e;
            --color-success-soft: rgba(34, 197, 94, 0.12);
            --color-error: #ef4444;
            --color-error-soft: rgba(239, 68, 68, 0.1);
            --shadow-md: 0 2px 6px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.06);
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --color-bg: #121212;
                --color-bg-elevated: #1e1e1e;
                --color-text: #e0e0e0;
                --color-text-secondary: #a0a0a0;
                --color-text-muted: #707070;
                --color-border: #333333;
                --color-accent: #e0e0e0;
                --color-success: #4ade80;
                --color-success-soft: rgba(74, 222, 128, 0.14);
                --color-error: #f87171;
                --color-error-soft: rgba(248, 113, 113, 0.14);
                --shadow-md: 0 2px 6px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.4);
            }
        }

        * { box-sizing: border-box; }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            margin: 0;
            background: var(--color-bg);
            color: var(--color-text);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .page-header {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.25rem 1.5rem;
        }

        .page-header .brand {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .page-header img {
            width: 32px;
            height: 32px;
            border-radius: 6px;
        }

        .page-header .app-name {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--color-text);
        }

        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            /* Bias above true center so it sits balanced under the header */
            padding: 2rem 1.5rem 16rem;
        }

        .card {
            width: 100%;
            max-width: 400px;
            background: var(--color-bg-elevated);
            padding: 2.5rem;
            border-radius: 12px;
            border: 1px solid var(--color-border);
            text-align: center;
            box-shadow: var(--shadow-md);
        }

        .status-badge {
            width: 64px;
            height: 64px;
            margin: 0 auto 1.5rem;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .status-badge.success { background: var(--color-success-soft); color: var(--color-success); }
        .status-badge.error { background: var(--color-error-soft); color: var(--color-error); }

        .status-badge svg {
            width: 34px;
            height: 34px;
        }

        h1 {
            font-size: 1.5rem;
            font-weight: 600;
            margin: 0 0 0.5rem;
            color: var(--color-text);
        }

        .subtitle {
            font-size: 0.9375rem;
            color: var(--color-text-secondary);
            line-height: 1.5;
            margin: 0;
        }

        .btn {
            display: inline-block;
            margin-top: 1.5rem;
            padding: 0.75rem 1.5rem;
            background: var(--color-accent);
            color: var(--color-bg-elevated);
            text-decoration: none;
            border-radius: 8px;
            font-weight: 500;
            font-size: 0.9375rem;
            border: 1px solid var(--color-accent);
            transition: opacity 150ms ease;
        }

        .btn:hover { opacity: 0.85; }

        .secondary-link {
            margin: 1rem 0 0;
        }

        .secondary-link a {
            color: var(--color-text-muted);
            font-size: 0.875rem;
            text-decoration: none;
        }

        .secondary-link a:hover {
            color: var(--color-text-secondary);
            text-decoration: underline;
        }
    `;
}

const SUCCESS_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>`;
const ERROR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="8" x2="12" y2="13"></line><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="9"></circle></svg>`;

export interface StatusPageOptions {
    title: string;
    message: string;
    status: 'success' | 'error';
    /** When set, shows an "Open Superjoy" button and (on success) auto-opens it. */
    deepLink?: string;
    /** Optional secondary same-tab link, e.g. a web fallback to a route. */
    link?: { href: string; label: string };
}

/** Renders a branded success/error status page as an HTML string. */
export function renderStatusPage(opts: StatusPageOptions): string {
    const { title, message, status, deepLink, link } = opts;
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const icon = status === 'success' ? SUCCESS_ICON : ERROR_ICON;

    const button = deepLink
        ? `<a href="${escapeHtml(deepLink)}" class="btn" id="open-app">Open Superjoy</a>`
        : '';
    const secondaryLink = link
        ? `<p class="secondary-link"><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`
        : '';
    // Only auto-foreground on success; on error keep the user on the page so
    // they can read the failure before choosing to return.
    const autoOpen = status === 'success' && deepLink
        ? `<script>setTimeout(function () { window.location.href = ${JSON.stringify(deepLink)}; }, 500);</script>`
        : '';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Superjoy - ${safeTitle}</title>
    <link rel="icon" type="image/png" href="/icons/pipali_64.png">
    <link rel="apple-touch-icon" href="/icons/superjoy_128.png">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${getStatusPageStyles()}</style>
</head>
<body>
    <header class="page-header">
        <div class="brand">
            <img src="/icons/superjoy_128.png" alt="Superjoy" />
            <span class="app-name">Superjoy</span>
        </div>
    </header>
    <main class="main-content">
        <div class="card">
            <div class="status-badge ${status}">${icon}</div>
            <h1>${safeTitle}</h1>
            <p class="subtitle">${safeMessage}</p>
            ${button}
            ${secondaryLink}
        </div>
    </main>
    ${autoOpen}
</body>
</html>`;
}
