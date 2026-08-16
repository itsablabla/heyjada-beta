import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { auth as runMcpOAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { db } from '../db';
import { McpServer } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
    loadEnabledMcpServers,
    reconnectMcpServer,
    disconnectMcpServer,
    getMcpServerStatuses,
    closeMcpClients,
} from '../processor/mcp';
import { McpClient, isMcpOAuthUnauthorizedError } from '../processor/mcp/client';
import {
    clearMcpOAuthState,
    DbMcpOAuthProvider,
    getMcpOAuthState,
    saveMcpOAuthResourceMetadataUrl,
} from '../processor/mcp/oauth-provider';
import { renderStatusPage } from './status-page';
import { createChildLogger } from '../logger';

// Deep link that returns the desktop app to the MCP tools page after OAuth
const TOOLS_DEEP_LINK = 'pipali://tools';

const log = createChildLogger({ component: 'mcp' });

const mcp = new Hono();

// Validation schemas
const createMcpServerSchema = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'Name must be lowercase alphanumeric with dashes/underscores'),
    description: z.string().max(512).optional(),
    transportType: z.enum(['stdio', 'http']),
    path: z.string().min(1),
    authType: z.enum(['none', 'bearer', 'oauth']).optional(),
    apiKey: z.string().optional(),
    oauthClientId: z.string().optional(),
    oauthClientSecret: z.string().optional(),
    oauthScopes: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    confirmationMode: z.enum(['always', 'unsafe_only', 'never']).optional(),
    enabled: z.boolean().optional(),
    enabledTools: z.array(z.string()).optional(),
});

const updateMcpServerSchema = createMcpServerSchema.partial().omit({ name: true });

function getOrigin(requestUrl: string): string {
    return new URL(requestUrl).origin;
}

function renderOAuthCallbackPage(title: string, message: string, success: boolean): Response {
    const html = renderStatusPage({
        title,
        message,
        status: success ? 'success' : 'error',
        // Foreground the desktop app back on the tools page where the user
        // started connecting the server. Harmless in the browser-only app.
        deepLink: TOOLS_DEEP_LINK,
        link: { href: '/tools', label: 'Return to tools' },
    });
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function cleanOptionalString(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function cleanOAuthScopes(scopes: string[] | undefined): string[] | null {
    const cleaned = [...new Set((scopes ?? []).map(scope => scope.trim()).filter(Boolean))];
    return cleaned.length > 0 ? cleaned : null;
}

function scopesEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
    const left = a ?? [];
    const right = b ?? [];
    return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function oauthScopeParam(scopes: string[] | null | undefined): string | undefined {
    return (scopes ?? []).map(scope => scope.trim()).filter(Boolean).join(' ') || undefined;
}

function isGoogleApisUrl(path: string): boolean {
    try {
        const { hostname } = new URL(path);
        return hostname === 'googleapis.com' || hostname.endsWith('.googleapis.com');
    } catch {
        return false;
    }
}

function buildGoogleResourceMetadataUrl(serverUrl: string, toolName: string): URL {
    const url = new URL(serverUrl);
    url.pathname = `/.well-known/oauth-protected-resource/${encodeURIComponent(toolName)}`;
    url.search = '';
    return url;
}

async function getFreshServer(id: number) {
    const [server] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    return server;
}

async function startMcpOAuth(server: typeof McpServer.$inferSelect, callbackOrigin: string): Promise<string | undefined> {
    try {
        await reconnectMcpServer(server.name, {
            oauthInteractive: true,
            callbackOrigin,
        });
    } catch (error) {
        if (!isMcpOAuthUnauthorizedError(error)) {
            throw error;
        }
    }
    const state = await getMcpOAuthState(server.id);
    return state?.lastAuthorizationUrl ?? undefined;
}

async function startGoogleWorkspaceMcpOAuth(server: typeof McpServer.$inferSelect, callbackOrigin: string): Promise<string | undefined> {
    const client = new McpClient(server);
    let tools: Awaited<ReturnType<McpClient['getTools']>> = [];
    try {
        await client.connect();
        tools = await client.getTools();
    } finally {
        await client.close();
    }

    // No MCP tool is called here. Google keys protected-resource metadata by
    // tool name, so any listed schema name can start the OAuth flow.
    const metadataToolName = tools[0]?.originalName;
    if (!metadataToolName) {
        throw new Error('Google Workspace MCP server did not return any tools to authorize.');
    }

    const resourceMetadataUrl = buildGoogleResourceMetadataUrl(server.path, metadataToolName);
    await saveMcpOAuthResourceMetadataUrl(server.id, resourceMetadataUrl.toString());

    const provider = new DbMcpOAuthProvider(server, {
        interactive: true,
        callbackOrigin,
    });
    await runMcpOAuth(provider, {
        serverUrl: server.path,
        resourceMetadataUrl,
        scope: oauthScopeParam(server.oauthScopes),
    });

    const state = await getMcpOAuthState(server.id);
    return state?.lastAuthorizationUrl ?? undefined;
}

async function startMcpOAuthWithFallback(server: typeof McpServer.$inferSelect, callbackOrigin: string): Promise<string | undefined> {
    const authorizationUrl = await startMcpOAuth(server, callbackOrigin);
    if (authorizationUrl || !isGoogleApisUrl(server.path)) {
        return authorizationUrl;
    }

    log.info({ server: server.name }, 'MCP reconnect did not start OAuth; using Google Workspace protected-resource metadata fallback');
    return startGoogleWorkspaceMcpOAuth(server, callbackOrigin);
}

// GET /api/mcp/servers - List all MCP servers
mcp.get('/servers', async (c) => {
    log.info('📋 Listing MCP servers');

    const servers = await db.select().from(McpServer);

    // Get connection statuses
    const statuses = getMcpServerStatuses();
    const statusMap = new Map(statuses.map(s => [s.name, s.status]));

    const result = servers.map(server => ({
        ...server,
        connectionStatus: statusMap.get(server.name) || 'disconnected',
    }));

    return c.json({ servers: result });
});

// POST /api/mcp/servers - Create new MCP server
mcp.post('/servers', zValidator('json', createMcpServerSchema), async (c) => {
    const input = c.req.valid('json');
    log.info(`✨ Creating MCP server "${input.name}"`);

    // Check if name already exists
    const [existing] = await db.select().from(McpServer).where(eq(McpServer.name, input.name));
    if (existing) {
        return c.json({ error: `MCP server with name "${input.name}" already exists` }, 400);
    }

    try {
        const authType = input.transportType === 'http'
            ? input.authType ?? (input.apiKey ? 'bearer' : 'none')
            : 'none';
        const oauthClientId = input.transportType === 'http' ? cleanOptionalString(input.oauthClientId) : null;
        const oauthClientSecret = input.transportType === 'http' ? cleanOptionalString(input.oauthClientSecret) : null;
        const oauthScopes = input.transportType === 'http' ? cleanOAuthScopes(input.oauthScopes) : null;
        const results = await db.insert(McpServer).values({
            name: input.name,
            description: input.description,
            transportType: input.transportType,
            path: input.path,
            authType,
            oauthStatus: authType === 'oauth' ? 'auth_pending' : 'not_connected',
            apiKey: authType === 'bearer' ? input.apiKey : null,
            oauthClientId,
            oauthClientSecret,
            oauthScopes,
            env: input.env,
            confirmationMode: input.confirmationMode ?? 'always',
            enabled: input.enabled ?? true,
            enabledTools: input.enabledTools,
        }).returning();

        const server = results[0];
        if (!server) {
            return c.json({ error: 'Failed to create MCP server' }, 500);
        }

        log.info(`✅ Created MCP server "${input.name}" (id: ${server.id})`);

        // If enabled, connect to the server
        let authorizationUrl: string | undefined;
        if (server.enabled) {
            try {
                if (server.authType === 'oauth') {
                    authorizationUrl = await startMcpOAuthWithFallback(server, getOrigin(c.req.url));
                } else {
                    await reconnectMcpServer(server.name);
                }
                log.info(`🔗 Connected to MCP server "${server.name}"`);
            } catch (error) {
                log.warn({ err: error }, 'Failed to connect to server');
                // Update last error
                await db.update(McpServer)
                    .set({ lastError: error instanceof Error ? error.message : String(error) })
                    .where(eq(McpServer.id, server.id));
            }
        }

        const freshServer = await getFreshServer(server.id);
        return c.json({ success: true, server: freshServer ?? server, authorizationUrl });
    } catch (error) {
        log.error({ err: error }, 'Failed to create server');
        return c.json({ error: 'Failed to create MCP server' }, 500);
    }
});

// GET /api/mcp/servers/:id - Get single server
mcp.get('/servers/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [server] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!server) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    // Get connection status
    const statuses = getMcpServerStatuses();
    const status = statuses.find(s => s.name === server.name);

    return c.json({
        server: {
            ...server,
            connectionStatus: status?.status || 'disconnected',
        }
    });
});

// PUT /api/mcp/servers/:id - Update server
mcp.put('/servers/:id', zValidator('json', updateMcpServerSchema), async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const input = c.req.valid('json');
    log.info(`✏️ Updating MCP server ${id}`);

    const [existing] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!existing) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    try {
        // Build update object with only defined fields
        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (input.description !== undefined) updateData.description = input.description;
        const nextTransportType = input.transportType ?? existing.transportType;
        const nextAuthType = nextTransportType === 'http'
            ? input.authType ?? existing.authType ?? (existing.apiKey ? 'bearer' : 'none')
            : 'none';
        const nextPath = input.path ?? existing.path;
        const nextOAuthClientId = input.oauthClientId !== undefined
            ? (nextTransportType === 'http' ? cleanOptionalString(input.oauthClientId) : null)
            : existing.oauthClientId;
        const nextOAuthClientSecret = input.oauthClientSecret !== undefined
            ? (nextTransportType === 'http' ? cleanOptionalString(input.oauthClientSecret) : null)
            : existing.oauthClientSecret;
        const nextOAuthScopes = input.oauthScopes !== undefined
            ? (nextTransportType === 'http' ? cleanOAuthScopes(input.oauthScopes) : null)
            : existing.oauthScopes;
        const oauthConfigChanged = nextOAuthClientId !== existing.oauthClientId
            || nextOAuthClientSecret !== existing.oauthClientSecret
            || nextPath !== existing.path
            || !scopesEqual(nextOAuthScopes, existing.oauthScopes);

        if (input.transportType !== undefined) updateData.transportType = input.transportType;
        if (input.path !== undefined) updateData.path = input.path;
        if (input.authType !== undefined || input.transportType !== undefined) {
            updateData.authType = nextAuthType;
            updateData.oauthStatus = nextAuthType === 'oauth' ? 'auth_pending' : 'not_connected';
            if (nextAuthType !== 'bearer') {
                updateData.apiKey = null;
            }
        }
        if (nextAuthType === 'bearer' && input.apiKey !== undefined) {
            updateData.apiKey = input.apiKey;
        }
        if (input.oauthClientId !== undefined || input.transportType !== undefined) {
            updateData.oauthClientId = nextTransportType === 'http' ? nextOAuthClientId : null;
        }
        if (input.oauthClientSecret !== undefined || input.transportType !== undefined) {
            updateData.oauthClientSecret = nextTransportType === 'http' ? nextOAuthClientSecret : null;
        }
        if (input.oauthScopes !== undefined || input.transportType !== undefined) {
            updateData.oauthScopes = nextTransportType === 'http' ? nextOAuthScopes : null;
        }
        if (input.env !== undefined) updateData.env = input.env;
        if (input.confirmationMode !== undefined) updateData.confirmationMode = input.confirmationMode;
        if (input.enabled !== undefined) updateData.enabled = input.enabled;
        if (input.enabledTools !== undefined) updateData.enabledTools = input.enabledTools;

        const results = await db.update(McpServer)
            .set(updateData)
            .where(eq(McpServer.id, id))
            .returning();

        const updated = results[0];
        if (!updated) {
            return c.json({ error: 'Failed to update MCP server' }, 500);
        }

        if (existing.authType === 'oauth' && (updated.authType !== 'oauth' || oauthConfigChanged)) {
            await clearMcpOAuthState(updated.id);
            await db
                .update(McpServer)
                .set({ oauthStatus: updated.authType === 'oauth' ? 'auth_pending' : 'not_connected', updatedAt: new Date() })
                .where(eq(McpServer.id, updated.id));
            updated.oauthStatus = updated.authType === 'oauth' ? 'auth_pending' : 'not_connected';
        }

        log.info(`✅ Updated MCP server "${updated.name}"`);

        // Match the active client registry to the updated enabled state.
        if (updated.enabled) {
            try {
                await reconnectMcpServer(updated.name);
                log.info(`🔗 Reconnected to MCP server "${updated.name}"`);
            } catch (error) {
                log.warn({ err: error }, 'Failed to reconnect');
            }
        } else {
            await disconnectMcpServer(updated.name);
            log.info(`Disconnected disabled MCP server "${updated.name}"`);
        }

        const statuses = getMcpServerStatuses();
        const status = statuses.find(s => s.name === updated.name);

        return c.json({
            success: true,
            server: {
                ...updated,
                connectionStatus: status?.status || 'disconnected',
            }
        });
    } catch (error) {
        log.error({ err: error }, 'Failed to update server');
        return c.json({ error: 'Failed to update MCP server' }, 500);
    }
});

// POST /api/mcp/servers/:id/oauth/reconnect - Start a fresh OAuth flow for an MCP server
mcp.post('/servers/:id/oauth/reconnect', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const server = await getFreshServer(id);
    if (!server) {
        return c.json({ error: 'MCP server not found' }, 404);
    }
    if (server.authType !== 'oauth') {
        return c.json({ error: 'MCP server is not configured for OAuth' }, 400);
    }

    try {
        await disconnectMcpServer(server.name);
        await clearMcpOAuthState(server.id);
        await db
            .update(McpServer)
            .set({
                oauthStatus: 'auth_pending',
                lastError: 'OAuth authorization is required. Complete the browser sign-in flow to connect this MCP server.',
                updatedAt: new Date(),
            })
            .where(eq(McpServer.id, server.id));

        const authorizationUrl = await startMcpOAuthWithFallback(server, getOrigin(c.req.url));
        const freshServer = await getFreshServer(server.id);
        return c.json({ success: true, server: freshServer ?? server, authorizationUrl });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await db
            .update(McpServer)
            .set({ oauthStatus: 'error', lastError: errorMessage, updatedAt: new Date() })
            .where(eq(McpServer.id, server.id));
        return c.json({ success: false, error: errorMessage }, 500);
    }
});

// GET /api/mcp/oauth/callback - Complete an MCP OAuth authorization code flow
mcp.get('/oauth/callback', async (c) => {
    const serverId = parseInt(c.req.query('server_id') ?? '');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    const errorDescription = c.req.query('error_description');

    if (isNaN(serverId)) {
        return renderOAuthCallbackPage('Invalid MCP OAuth callback', 'The callback did not include a valid MCP server ID.', false);
    }

    const server = await getFreshServer(serverId);
    if (!server) {
        return renderOAuthCallbackPage('MCP server not found', 'HeyJada could not find the MCP server for this OAuth callback.', false);
    }

    if (error) {
        const message = errorDescription || error;
        await db
            .update(McpServer)
            .set({ oauthStatus: 'auth_required', lastError: message, updatedAt: new Date() })
            .where(eq(McpServer.id, server.id));
        return renderOAuthCallbackPage(`Could not connect ${server.name}`, message, false);
    }

    if (!code || !state) {
        return renderOAuthCallbackPage(`Could not connect ${server.name}`, 'The OAuth callback was missing a code or state.', false);
    }

    const storedState = await getMcpOAuthState(server.id);
    if (!storedState?.state || storedState.state !== state) {
        await db
            .update(McpServer)
            .set({ oauthStatus: 'auth_required', lastError: 'OAuth state mismatch. Please reconnect the MCP server.', updatedAt: new Date() })
            .where(eq(McpServer.id, server.id));
        return renderOAuthCallbackPage(`Could not connect ${server.name}`, 'OAuth state mismatch. Please reconnect the MCP server.', false);
    }

    try {
        const provider = new DbMcpOAuthProvider(server, { callbackOrigin: getOrigin(c.req.url) });
        const resourceMetadataUrl = storedState.resourceMetadataUrl
            ? new URL(storedState.resourceMetadataUrl)
            : undefined;
        await runMcpOAuth(provider, {
            serverUrl: server.path,
            authorizationCode: code,
            resourceMetadataUrl,
            scope: oauthScopeParam(server.oauthScopes),
        });
        await db
            .update(McpServer)
            .set({ oauthStatus: 'connected', lastError: null, updatedAt: new Date() })
            .where(eq(McpServer.id, server.id));
        await reconnectMcpServer(server.name, { oauthInteractive: false, callbackOrigin: getOrigin(c.req.url) });
        return renderOAuthCallbackPage(`${server.name} connected`, 'Authorization complete. Returning you to HeyJada — you can close this tab once the app is in focus.', true);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, server: server.name }, 'Failed to complete MCP OAuth callback');
        await db
            .update(McpServer)
            .set({ oauthStatus: 'auth_required', lastError: message, updatedAt: new Date() })
            .where(eq(McpServer.id, server.id));
        return renderOAuthCallbackPage(`Could not connect ${server.name}`, message, false);
    }
});

// DELETE /api/mcp/servers/:id - Delete server
mcp.delete('/servers/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [existing] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!existing) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    log.info(`🗑️ Deleting MCP server "${existing.name}"`);

    await db.delete(McpServer).where(eq(McpServer.id, id));

    // Reload servers to remove the client
    await closeMcpClients();
    await loadEnabledMcpServers();

    log.info(`✅ Deleted MCP server "${existing.name}"`);
    return c.json({ success: true });
});

// POST /api/mcp/servers/:id/test - Test connection to server
mcp.post('/servers/:id/test', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [server] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!server) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    log.info(`🧪 Testing connection to MCP server "${server.name}"`);

    try {
        const client = new McpClient(server);
        await client.connect();
        const tools = await client.getTools();
        await client.close();

        // Update last connected timestamp
        await db.update(McpServer)
            .set({ lastConnectedAt: new Date(), lastError: null })
            .where(eq(McpServer.id, id));

        log.info(`✅ Connection test successful - ${tools.length} tools available`);

        return c.json({
            success: true,
            toolCount: tools.length,
            tools: tools.map(t => ({
                name: t.originalName,
                description: t.description,
            })),
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ err: errorMessage }, 'Connection test failed');

        // Update last error
        const oauthUpdate = server.authType === 'oauth'
            ? { oauthStatus: 'auth_required' as const }
            : {};
        await db.update(McpServer)
            .set({ lastError: errorMessage, ...oauthUpdate })
            .where(eq(McpServer.id, id));

        return c.json({ success: false, error: errorMessage }, 500);
    }
});

// GET /api/mcp/servers/:id/tools - List tools from a specific server
mcp.get('/servers/:id/tools', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [server] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!server) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    log.info(`📋 Listing tools from MCP server "${server.name}"`);

    try {
        const client = new McpClient(server);
        await client.connect();
        const tools = await client.getTools();
        await client.close();

        return c.json({
            server: server.name,
            tools: tools.map(t => ({
                name: t.originalName,
                namespacedName: t.namespacedName,
                description: t.description,
                inputSchema: t.inputSchema,
            })),
        });
    } catch (error) {
        log.error({ err: error }, 'Failed to list tools');
        return c.json({
            error: error instanceof Error ? error.message : 'Failed to list tools'
        }, 500);
    }
});

// POST /api/mcp/reload - Reload all MCP servers
mcp.post('/reload', async (c) => {
    log.info('Reloading all MCP servers...');

    try {
        await closeMcpClients();
        await loadEnabledMcpServers();

        const statuses = getMcpServerStatuses();
        log.info({ count: statuses.length }, 'Reloaded MCP servers');

        return c.json({
            success: true,
            servers: statuses,
        });
    } catch (error) {
        log.error({ err: error }, 'Failed to reload servers');
        return c.json({ error: 'Failed to reload MCP servers' }, 500);
    }
});

export default mcp;
