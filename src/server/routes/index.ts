import path from 'path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'
import {
    EMBEDDED_INDEX_HTML,
    EMBEDDED_STYLES_CSS,
    EMBEDDED_APP_JS,
    EMBEDDED_ICONS,
    EMBEDDED_BRAND,
    IS_COMPILED_BINARY,
} from '../embedded-assets';

const app = new Hono();

// Web App manifest — lets the UI be installed as a PWA when served from a
// (remote) server. Served from a constant so it works in both dev and
// compiled-binary modes without touching the asset embedding pipeline.
const WEB_APP_MANIFEST = {
    name: 'Superjoy',
    short_name: 'Superjoy',
    description: 'Superjoy — an AI co-worker that can safely interact with files + the web to finish real work.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#1a1a1a',
    theme_color: '#1a1a1a',
    icons: [
        { src: '/icons/superjoy_64.png', sizes: '64x64', type: 'image/png' },
        { src: '/icons/superjoy_128.png', sizes: '128x128', type: 'image/png' },
        { src: '/icons/superjoy_256.png', sizes: '256x256', type: 'image/png' },
        { src: '/icons/superjoy_512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
};

app.get('/manifest.webmanifest', (c) => {
    return c.body(JSON.stringify(WEB_APP_MANIFEST), 200, {
        'Content-Type': 'application/manifest+json',
    });
});

if (IS_COMPILED_BINARY) {
    // Serve embedded assets from memory
    app.get('/', (c) => {
        return c.html(EMBEDDED_INDEX_HTML);
    });

    app.get('/styles/index.css', (c) => {
        return c.text(EMBEDDED_STYLES_CSS, 200, {
            'Content-Type': 'text/css',
        });
    });

    app.get('/dist/app.js', (c) => {
        return c.text(EMBEDDED_APP_JS, 200, {
            'Content-Type': 'application/javascript',
        });
    });

    // Serve embedded icons
    app.get('/icons/:filename', (c) => {
        const filename = c.req.param('filename');
        const iconData = EMBEDDED_ICONS[filename];
        if (iconData) {
            const buffer = Buffer.from(iconData, 'base64');
            return c.body(buffer, 200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=31536000',
            });
        }
        return c.notFound();
    });

    // Serve embedded brand images
    app.get('/brand/:filename', (c) => {
        const filename = c.req.param('filename');
        const brandData = EMBEDDED_BRAND[filename];
        if (brandData) {
            const buffer = Buffer.from(brandData, 'base64');
            const contentType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
            return c.body(buffer, 200, {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000',
            });
        }
        return c.notFound();
    });

    // Fallback for any other routes - serve index.html for SPA routing
    app.get('*', (c) => {
        return c.html(EMBEDDED_INDEX_HTML);
    });
} else {
    const clientRoot = process.env.PIPALI_SERVER_RESOURCE_DIR
        ? path.join(process.env.PIPALI_SERVER_RESOURCE_DIR, 'src', 'client')
        : './src/client';
    // Development mode - serve from disk
    app.get('/', serveStatic({ path: path.join(clientRoot, 'index.html') }));
    // Serve public assets (icons, etc.)
    app.get('/icons/*', serveStatic({ root: path.join(clientRoot, 'public') }));
    // Serve brand images (hero watermark, avatar, etc.)
    app.get('/brand/*', serveStatic({ root: path.join(clientRoot, 'public') }));
    // Serve static files (CSS, JS, etc.)
    app.get('*', serveStatic({ root: clientRoot }));
    // Fallback for SPA routing - serve index.html for any unmatched routes
    app.get('*', async (c) => {
        const html = await Bun.file(path.join(clientRoot, 'index.html')).text();
        return c.html(html);
    });
}

export default app;