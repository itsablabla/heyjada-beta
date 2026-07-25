import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test server configuration
const TEST_PORT = 6466; // Different from dev (6464), platform (6465) ports
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

export default defineConfig({
    testDir: './tests/e2e/specs',

    // Keep Playwright tests out of `bun test` (Bun auto-runs `*.spec.*`).
    testMatch: '**/*.e2e.ts',

    // Run tests sequentially (tests share server state)
    fullyParallel: false,

    // Fail fast for CI
    forbidOnly: !!process.env.CI,

    // Retry failed tests
    retries: process.env.CI ? 2 : 0,

    // Single worker since tests share a server
    workers: 1,

    // Reporter
    reporter: process.env.CI ? 'github' : 'html',

    // Global setup for server lifecycle
    globalSetup: resolve(__dirname, './tests/e2e/global-setup.ts'),
    globalTeardown: resolve(__dirname, './tests/e2e/global-teardown.ts'),

    use: {
        baseURL: BASE_URL,

        // The app ships with the sidebar collapsed to an icon rail; expand it so
        // specs can assert against the conversation list it contains.
        storageState: {
            cookies: [],
            origins: [{
                origin: BASE_URL,
                localStorage: [{ name: 'pipali-sidebar-open', value: 'true' }],
            }],
        },

        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',

        // Timeouts
        actionTimeout: 10000,
        navigationTimeout: 15000,
    },

    // Increase test timeout for E2E tests with mock delays
    timeout: 60000,

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
