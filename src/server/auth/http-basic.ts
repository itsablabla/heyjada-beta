/**
 * HTTP Basic Authentication for the HeyJada web app.
 *
 * Protects every HTTP route and the WebSocket upgrade with a single
 * username/password check, so the app can safely run on a remote server.
 *
 * Configuration (environment variables):
 * - HEYJADA_AUTH_USERNAME  Login username (default: "admin")
 * - HEYJADA_AUTH_PASSWORD  Login password. If unset, a random password is
 *                          generated on first run and persisted to
 *                          <config-dir>/auth.json so it survives restarts.
 * - HEYJADA_AUTH_DISABLED  Set to "true" to turn authentication off.
 *
 * Authentication is skipped automatically when running as the Tauri desktop
 * sidecar (PIPALI_SERVER_RESOURCE_DIR set) or in test mode (PIPALI_TEST_MODE),
 * where the server only listens on localhost for a trusted local shell.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { getAppConfigDir } from '../paths';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'basic-auth' });

let credentials: { username: string; password: string } | null = null;
let initialized = false;

function isAuthDisabled(): boolean {
    if (process.env.HEYJADA_AUTH_DISABLED === 'true') return true;
    // Tauri desktop sidecar: local, single-user, spawned by the desktop shell.
    if (process.env.PIPALI_SERVER_RESOURCE_DIR) return true;
    // Test mode: e2e fixtures talk to the server without credentials.
    if (process.env.PIPALI_TEST_MODE === 'true') return true;
    return false;
}

function loadOrCreateCredentials(): { username: string; password: string } {
    const username = process.env.HEYJADA_AUTH_USERNAME || 'admin';
    if (process.env.HEYJADA_AUTH_PASSWORD) {
        return { username, password: process.env.HEYJADA_AUTH_PASSWORD };
    }

    // No password configured: load or generate one persisted in the config dir.
    const authFile = path.join(getAppConfigDir(), 'auth.json');
    try {
        const saved = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
        if (typeof saved.password === 'string' && saved.password.length > 0) {
            return { username: saved.username || username, password: saved.password };
        }
    } catch {
        // Missing or unreadable: fall through and generate a fresh one.
    }

    const password = randomBytes(18).toString('base64url');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ username, password }, null, 2) + '\n', { mode: 0o600 });
    log.info(`🔑 Generated web login credentials for user "${username}" — see ${authFile}`);
    return { username, password };
}

/**
 * Initialize the auth gate. Call once at startup, before serving requests.
 */
export function initBasicAuth(): void {
    initialized = true;
    if (isAuthDisabled()) {
        credentials = null;
        log.info('Web authentication disabled');
        return;
    }
    credentials = loadOrCreateCredentials();
    log.info(`🔒 Web authentication enabled (user: ${credentials.username})`);
}

function safeEqual(a: string, b: string): boolean {
    // Hash both sides so buffers are equal length for timingSafeEqual.
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
}

/**
 * Check a request against the configured credentials.
 * Returns null when the request may proceed, or a 401 response otherwise.
 * Covers both plain HTTP requests and the WebSocket upgrade handshake
 * (browsers replay cached Basic credentials on same-origin upgrades).
 */
export function checkBasicAuth(req: Request): Response | null {
    if (!initialized) initBasicAuth();
    if (!credentials) return null;

    const header = req.headers.get('authorization');
    if (header?.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
            const sep = decoded.indexOf(':');
            const user = decoded.slice(0, sep);
            const pass = decoded.slice(sep + 1);
            const userOk = safeEqual(user, credentials.username);
            const passOk = safeEqual(pass, credentials.password);
            if (sep >= 0 && userOk && passOk) return null;
        } catch {
            // Malformed header: fall through to 401.
        }
    }

    return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="HeyJada", charset="UTF-8"' },
    });
}
