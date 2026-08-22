import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { parseArgs } from "util";
import { db, closeDatabase } from "./db";
import { runMaintenanceMigrations } from "./db/maintenance";
import app from "./routes";
import api from "./routes/api";
import { initializeDatabase } from "./init";
import { getMigrationsFolder } from "./utils";
import { loadSkills, installBuiltinSkills } from "./skills";
import { initializeUserContext } from "./user-context";
import { websocketHandler, type WebSocketData } from "./routes/ws";
import {
    IS_COMPILED_BINARY,
    EMBEDDED_MIGRATIONS,
} from "./embedded-assets";
import { startAutomationSystem, stopAutomationSystem } from "./automation";
import { loadEnabledMcpServers, closeMcpClients } from "./processor/mcp";
import { configureAuth, isAuthenticated, getPlatformUserInfo } from "./auth";
import { createChildLogger } from './logger';
import { initializeSandbox, shutdownSandbox } from './sandbox';
import { killAllBackgroundProcesses } from './events/background-processes';
import { initPlatformTransport, shutdownPlatformTransport } from './telemetry/platform-transport';
import { setServer } from './server-instance';
import { getBrandedEnv } from './env';
import { getLocalAuthStatus, verifyLocalSessionFromRequest } from './auth/local-auth';
import { timingSafeEqual } from 'node:crypto';

const log = createChildLogger({ component: 'server' });

// Parse CLI arguments
function getServerConfig() {
    const env = getBrandedEnv;
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            host: {
                type: "string",
                short: "h",
                default: env("HOST") || "127.0.0.1",
            },
            port: {
                type: "string",
                short: "p",
                default: env("PORT") || "6464",
            },
            anon: {
                type: "boolean",
                default: env("ANON_MODE") === "true",
            },
            "platform-url": {
                type: "string",
                default: env("PLATFORM_URL") || "https://platform.pipali.ai",
            },
            "auth-username": {
                type: "string",
                default: env("AUTH_USERNAME"),
            },
            "auth-password": {
                type: "string",
                default: env("AUTH_PASSWORD"),
            },
            help: {
                type: "boolean",
                default: false,
            },
        },
        strict: true,
        allowPositionals: false,
    });

    if (values.help) {
        log.info(`
Superjoy - Personal AI Assistant

Usage: superjoy [options]

Options:
  -h, --host <host>        Host to bind to (default: 127.0.0.1, env: SUPERJOY_HOST)
  -p, --port <port>        Port to listen on (default: 6464, env: SUPERJOY_PORT)
      --anon               Skip platform authentication, use local API keys (env: SUPERJOY_ANON_MODE)
      --platform-url <url> Platform URL for authentication (env: SUPERJOY_PLATFORM_URL)
      --auth-username <u>  Username for HTTP Basic Auth (env: SUPERJOY_AUTH_USERNAME)
      --auth-password <p>  Password for HTTP Basic Auth (env: SUPERJOY_AUTH_PASSWORD)
                            Basic Auth is only active when SUPERJOY_BASIC_AUTH=true
                            Local username/password + email OTP is enabled by SUPERJOY_LOCAL_AUTH=true
      --help               Show this help message

Deprecated: HEYJADA_* environment variables still work as fallbacks but emit a warning.

Examples:
  superjoy                       # Start with platform authentication
  superjoy --anon                # Start without authentication (use local API keys)
  superjoy -p 8080               # Start on 127.0.0.1:8080
  superjoy --host 0.0.0.0        # Start on all interfaces (remote server / web app)
`);
        process.exit(0);
    }

    return {
        host: values.host as string,
        port: parseInt(values.port as string, 10),
        anon: values.anon as boolean,
        platformUrl: values["platform-url"] as string,
        authUsername: values["auth-username"] as string | undefined,
        authPassword: values["auth-password"] as string | undefined,
    };
}

async function runEmbeddedMigrations() {
    log.info("Running embedded migrations...");

    // Create migrations table if it doesn't exist
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
        )
    `);

    await runTaggedMigrations(EMBEDDED_MIGRATIONS);
}

type TaggedMigration = { sql: string; tag: string };

async function runTaggedMigrations(migrations: TaggedMigration[]) {
    // Get already applied migrations
    const applied = await db.execute(sql`SELECT hash FROM "__drizzle_migrations"`);
    const appliedHashes = new Set((applied.rows as any[]).map(r => r.hash));

    // Run each migration that hasn't been applied
    for (const migration of migrations) {
        const hash = migration.tag;

        if (appliedHashes.has(hash)) {
            log.info(`  ⏭️  Skipping ${hash} (already applied)`);
            continue;
        }

        log.info(`  🔄 Running migration: ${hash}`);

        // Wrap entire migration in a transaction so partial failures roll back cleanly.
        // PostgreSQL (and PGlite) support transactional DDL, so CREATE TABLE,
        // ALTER TABLE etc. are all rolled back if any statement fails.
        // This prevents corrupted DB state from half-applied migrations.
        await db.transaction(async (tx) => {
            // Split by the Drizzle breakpoint marker and execute each statement
            const statements = migration.sql.split('--> statement-breakpoint');

            for (const statement of statements) {
                const trimmed = statement.trim();
                if (trimmed) {
                    await tx.execute(sql.raw(trimmed));
                }
            }

            // Record the migration (inside the same transaction)
            await tx.execute(sql`
                INSERT INTO "__drizzle_migrations" (hash, created_at)
                VALUES (${hash}, ${Date.now()})
            `);
        });

        log.info(`  ✅ Applied: ${hash}`);
    }

    log.info("Migrations complete.");
}

async function runBundledMigrations() {
    const migrationsFolder = getMigrationsFolder();
    const journalPath = `${migrationsFolder}/meta/_journal.json`;
    const journal = await Bun.file(journalPath).json();
    const migrations: TaggedMigration[] = [];

    if (!journal?.entries || !Array.isArray(journal.entries)) {
        throw new Error(`Invalid migration journal at ${journalPath}`);
    }

    for (const entry of journal.entries) {
        const migrationPath = `${migrationsFolder}/${entry.tag}.sql`;
        const sqlText = await Bun.file(migrationPath).text();
        migrations.push({ tag: entry.tag, sql: sqlText });
    }

    log.info("Running bundled migrations...");
    // Ensure migrations table exists (legacy tag-based tracking)
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
        )
    `);
    await runTaggedMigrations(migrations);
}

async function main() {
    // Parse CLI arguments
    const config = getServerConfig();

    // Configure auth module
    configureAuth({
        platformUrl: config.platformUrl,
        anonMode: config.anon,
    });

    // Run migrations - either embedded, bundled, or from disk
    if (IS_COMPILED_BINARY) {
        await runEmbeddedMigrations();
    } else if (process.env.PIPALI_SERVER_RESOURCE_DIR) {
        await runBundledMigrations();
    } else {
        await migrate(db, { migrationsFolder: getMigrationsFolder() });
    }

    await runMaintenanceMigrations();

    // Initialize database (creates user, sets up models from env vars in anon mode)
    await initializeDatabase();

    // Check if already authenticated (before starting server)
    const alreadyAuthenticated = !config.anon && await isAuthenticated();
    if (alreadyAuthenticated) {
        log.info('🔐 Using existing platform authentication');
    } else if (config.anon) {
        log.info('🔓 Running in anonymous mode (using local API keys)');
    }

    // Install builtin skills to global directory (skips if already exists)
    const builtinResult = await installBuiltinSkills();
    if (builtinResult.installed.length > 0) {
        log.info(`📦 Installed builtin skill(s): ${builtinResult.installed.join(', ')}`);
    }

    // Load skills from global and local paths
    const skillResult = await loadSkills();
    if (skillResult.errors.length > 0) {
        for (const error of skillResult.errors) {
            log.warn(`⚠️  ${error.path}: ${error.message}`);
        }
    }
    if (skillResult.skills.length > 0) {
        log.info(`🎯 Loaded ${skillResult.skills.length} skill(s): ${skillResult.skills.map(s => s.name).join(', ')}`);
    }

    // Initialize user context file (creates template if not exists)
    // If already authenticated, fetch user info to populate name
    let userInfo: { name?: string } | undefined;
    if (alreadyAuthenticated) {
        const platformUser = await getPlatformUserInfo();
        if (platformUser?.name) {
            userInfo = { name: platformUser.name };
        }
    }
    await initializeUserContext(userInfo);

    // Initialize sandbox runtime (for secure shell command execution)
    await initializeSandbox();

    // Initialize platform transport (sends error logs to platform for diagnostics)
    initPlatformTransport();

    // Start automation system (cron scheduler, file watchers)
    await startAutomationSystem();

    // Load enabled MCP servers asynchronously to not block server startup
    loadEnabledMcpServers().catch(error => {
        log.warn(`⚠️ Failed to load MCP servers:`, error);
    });

    // Build frontend only in development mode (not when running as compiled binary)
    if (!IS_COMPILED_BINARY && !process.env.PIPALI_SERVER_RESOURCE_DIR) {
        log.info("Building frontend...");
        await Bun.build({
            entrypoints: ["src/client/app.tsx"],
            outdir: "src/client/dist",
            loader: {
                ".css": "css",
            },
        });
        log.info("Frontend built.");
    } else if (IS_COMPILED_BINARY) {
        log.info("Running in compiled mode - using embedded assets.");
    } else {
        log.info("Skipping frontend build (bundled server resources).");
    }

  // Disable development mode (hot reload) in test mode or compiled binary
  // This prevents Bun from restarting the server when files change during tests
  const isDevelopmentMode = !IS_COMPILED_BINARY && process.env.PIPALI_TEST_MODE !== 'true';

  // Paths for quieter logging (e.g frequent polling endpoints)
  const QUIETER_PATHS = new Set(['/api/automations/confirmations/pending']);

  // HTTP Basic Auth is opt-in for headless use. Local auth below is the default
  // browser-oriented protection when configured or after first-run setup.
  const basicAuthRequested = getBrandedEnv('BASIC_AUTH') === 'true';
  const basicAuthEnabled = basicAuthRequested && !!(config.authUsername && config.authPassword);
  const expectedAuthHeader = basicAuthEnabled
      ? new TextEncoder().encode(`Basic ${Buffer.from(`${config.authUsername}:${config.authPassword}`).toString('base64')}`)
      : null;

  const isAuthorized = (req: Request): boolean => {
      if (!expectedAuthHeader) return true;
      const header = req.headers.get('authorization');
      if (!header) return false;
      const given = new TextEncoder().encode(header);
      if (given.length !== expectedAuthHeader.length) return false;
      return timingSafeEqual(given, expectedAuthHeader);
  };

  if (basicAuthEnabled) {
      log.info('🔒 HTTP Basic Auth enabled - all routes require a username and password');
  } else if (basicAuthRequested) {
      log.warn('⚠️  SUPERJOY_BASIC_AUTH=true was set, but Basic Auth credentials are missing.');
  }

  const initialLocalAuthStatus = await getLocalAuthStatus();
  if (initialLocalAuthStatus.enabled) {
      log.info(initialLocalAuthStatus.needsSetup
          ? '🔐 Local auth enabled - first-run account setup is required'
          : '🔐 Local auth enabled - browser sessions require username, password, and email OTP');
      const resendConfigured = !!(process.env.RESEND_API_KEY || getBrandedEnv('RESEND_API_KEY')) && !!getBrandedEnv('OTP_FROM');
      if (!resendConfigured) {
          log.warn('⚠️  Local auth is enabled but email delivery is not configured. Set RESEND_API_KEY and SUPERJOY_OTP_FROM, or login OTP emails cannot be sent.');
      }
  } else if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      log.warn('⚠️  Server is exposed beyond localhost without local auth. Set SUPERJOY_LOCAL_AUTH=true or SUPERJOY_BASIC_AUTH=true to protect it.');
  }

  const server = Bun.serve<WebSocketData, any>({
    async fetch(req, server) {
        const url = new URL(req.url);
        if (QUIETER_PATHS.has(url.pathname)) {
            log.debug(`[${req.method}] ${url.pathname}`);
        } else {
            log.info(`[${req.method}] ${url.pathname}`);
        }

        const authExempt = isLocalAuthExempt(url.pathname, req.method);

        if (!authExempt) {
            const localAuthStatus = await getLocalAuthStatus();
            const basicAuthorized = basicAuthEnabled && isAuthorized(req);
            const localSession = localAuthStatus.enabled && !basicAuthorized
                ? await verifyLocalSessionFromRequest(req)
                : null;
            const authorized = basicAuthorized || !!localSession;

            if (!authorized) {
                if (localAuthStatus.enabled) {
                    if (url.pathname === "/ws/chat" || url.pathname.startsWith("/api")) {
                        return new Response('Authentication required', { status: 401 });
                    }
                    // Let the SPA shell and login assets load; the client renders login.
                } else if (basicAuthEnabled) {
                    return basicAuthChallenge();
                }
            }
        }

        // WebSocket
        if (url.pathname === "/ws/chat") {
            const success = server.upgrade(req, {
                data: {
                    // Initialize data if needed
                }
            });
            if (success) {
                return undefined;
            }
        }

        // API
        if (url.pathname.startsWith("/api")) {
            const res = await api.fetch(req, server);
            return res;
        }

        // Static and frontend routes
        const res = await app.fetch(req, server);
        return res;
    },
    websocket: websocketHandler,
    hostname: config.host,
    port: config.port,
    development: isDevelopmentMode,
  });

  setServer(server);

  log.info(`Server listening on http://${config.host}:${server.port}`);

  // Log auth status (authentication is now handled via the frontend login page)
  if (!config.anon && !alreadyAuthenticated) {
      log.info('🔐 Authentication required - sign in via the web interface');
      log.info(`   Platform: ${config.platformUrl}`);
  }

  // Graceful shutdown handlers to prevent database corruption
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    log.info(`\nReceived ${signal}, shutting down gracefully...`);

    const forceExitTimer = setTimeout(() => {
      log.error('Graceful shutdown timed out, forcing exit.');
      process.exit(1);
    }, 8_000);

    try {
      server.stop();
      killAllBackgroundProcesses();
      await stopAutomationSystem();
      await closeMcpClients();
      await shutdownSandbox();
      await shutdownPlatformTransport();
      await closeDatabase();
      log.info('Shutdown complete.');
      process.exit(0);
    } finally {
      clearTimeout(forceExitTimer);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('SIGQUIT', () => void shutdown('SIGQUIT'));
}

function basicAuthChallenge(): Response {
    return new Response('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Superjoy", charset="UTF-8"' },
    });
}

function isLocalAuthExempt(pathname: string, method: string): boolean {
    if (method === 'OPTIONS') return true;
    if (pathname === '/api/health' || pathname === '/health') return true;
    if (pathname === '/api/auth/status') return true;
    return pathname.startsWith('/api/auth/local/');
}

main();
