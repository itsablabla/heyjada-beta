import { eq } from 'drizzle-orm';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { db } from '../../db';
import { McpOAuthState, McpServer } from '../../db/schema';
import { getServer } from '../../server-instance';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'mcp-oauth' });

type McpServerRow = typeof McpServer.$inferSelect;
type McpOAuthStateRow = typeof McpOAuthState.$inferSelect;

function cleanOAuthScopes(scopes: string[] | null | undefined): string | undefined {
    const cleaned = (scopes ?? []).map(scope => scope.trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(' ') : undefined;
}

async function openBrowser(url: string): Promise<void> {
    if (process.env.PIPALI_TEST_MODE === 'true') {
        return;
    }

    const command = process.platform === 'darwin'
        ? ['open', url]
        : process.platform === 'win32'
            ? ['cmd', '/c', 'start', '', url]
            : ['xdg-open', url];

    const proc = Bun.spawn(command, {
        stdout: 'ignore',
        stderr: 'ignore',
    });
    await proc.exited;
}

function inferLocalOrigin(): string {
    const server = getServer();
    const port = server?.port ?? process.env.PIPALI_PORT ?? 6464;
    return `http://localhost:${port}`;
}

async function getState(serverId: number): Promise<McpOAuthStateRow | undefined> {
    const [state] = await db
        .select()
        .from(McpOAuthState)
        .where(eq(McpOAuthState.serverId, serverId));
    return state;
}

async function patchState(serverId: number, patch: Partial<typeof McpOAuthState.$inferInsert>): Promise<void> {
    const existing = await getState(serverId);
    if (existing) {
        await db
            .update(McpOAuthState)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(McpOAuthState.serverId, serverId));
        return;
    }

    await db.insert(McpOAuthState).values({
        serverId,
        ...patch,
    });
}

export async function clearMcpOAuthState(serverId: number, scope: 'all' | 'client' | 'tokens' | 'verifier' = 'all'): Promise<void> {
    if (scope === 'all') {
        await db.delete(McpOAuthState).where(eq(McpOAuthState.serverId, serverId));
        return;
    }

    const patch: Partial<typeof McpOAuthState.$inferInsert> = {};
    if (scope === 'client') {
        patch.clientInformation = null;
        patch.authorizationServerUrl = null;
        patch.resourceMetadataUrl = null;
        patch.resourceUrl = null;
        patch.scope = null;
    } else if (scope === 'tokens') {
        patch.tokens = null;
    } else if (scope === 'verifier') {
        patch.codeVerifier = null;
        patch.state = null;
    }

    await patchState(serverId, patch);
}

export async function getMcpOAuthState(serverId: number): Promise<McpOAuthStateRow | undefined> {
    return getState(serverId);
}

export async function saveMcpOAuthResourceMetadataUrl(serverId: number, resourceMetadataUrl: string): Promise<void> {
    await patchState(serverId, { resourceMetadataUrl });
}

export class DbMcpOAuthProvider implements OAuthClientProvider {
    private server: McpServerRow;
    private callbackOrigin: string;
    private interactive: boolean;

    constructor(server: McpServerRow, options: { callbackOrigin?: string; interactive?: boolean } = {}) {
        this.server = server;
        this.callbackOrigin = options.callbackOrigin ?? inferLocalOrigin();
        this.interactive = options.interactive ?? false;
    }

    get redirectUrl(): string {
        const url = new URL('/api/mcp/oauth/callback', this.callbackOrigin);
        url.searchParams.set('server_id', String(this.server.id));
        return url.toString();
    }

    get clientMetadata(): OAuthClientMetadata {
        const scope = cleanOAuthScopes(this.server.oauthScopes);
        return {
            client_name: 'Superjoy',
            redirect_uris: [this.redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: this.server.oauthClientSecret ? 'client_secret_post' : 'none',
            ...(scope ? { scope } : {}),
        };
    }

    async state(): Promise<string> {
        const value = crypto.randomUUID();
        await patchState(this.server.id, { state: value });
        return value;
    }

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        const clientId = this.server.oauthClientId?.trim();
        if (clientId) {
            const clientSecret = this.server.oauthClientSecret?.trim();
            return {
                client_id: clientId,
                ...(clientSecret ? { client_secret: clientSecret } : {}),
                token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none',
            };
        }

        const state = await getState(this.server.id);
        return state?.clientInformation as OAuthClientInformationMixed | undefined;
    }

    async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
        await patchState(this.server.id, {
            clientInformation: clientInformation as Record<string, unknown>,
        });
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        const state = await getState(this.server.id);
        return state?.tokens as OAuthTokens | undefined;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        await patchState(this.server.id, {
            tokens: tokens as Record<string, unknown>,
            scope: tokens.scope ?? null,
        });
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        const authorizationServerUrl = new URL('/', authorizationUrl).toString();
        await patchState(this.server.id, {
            authorizationServerUrl,
            lastAuthorizationUrl: authorizationUrl.toString(),
        });
        await db
            .update(McpServer)
            .set({
                oauthStatus: 'auth_pending',
                lastError: 'OAuth authorization is required. Complete the browser sign-in flow to connect this MCP server.',
                updatedAt: new Date(),
            })
            .where(eq(McpServer.id, this.server.id));

        if (this.interactive) {
            log.info({ server: this.server.name }, 'Opening MCP OAuth authorization URL');
            await openBrowser(authorizationUrl.toString());
        }
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        await patchState(this.server.id, { codeVerifier });
    }

    async codeVerifier(): Promise<string> {
        const state = await getState(this.server.id);
        if (!state?.codeVerifier) {
            throw new Error('Missing OAuth code verifier for MCP server');
        }
        return state.codeVerifier;
    }

    async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
        const requestedResource = new URL(serverUrl);
        if (!resource) {
            await patchState(this.server.id, { resourceUrl: requestedResource.toString() });
            return undefined;
        }

        if (!checkResourceAllowed({ requestedResource, configuredResource: resource })) {
            throw new Error(`Protected resource ${resource} does not match expected ${requestedResource.toString()} (or origin)`);
        }

        await patchState(this.server.id, { resourceUrl: resource });
        return new URL(resource);
    }

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
        await clearMcpOAuthState(this.server.id, scope);
    }
}
