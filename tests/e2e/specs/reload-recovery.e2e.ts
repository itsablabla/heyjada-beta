/**
 * Reload Recovery Tests
 *
 * Verifies that page state survives reloads:
 * - Active run steps are not duplicated after chat or home reload
 * - Acknowledged confirmations don't reappear
 * - Task cards persist via localStorage hydration
 * - Pending confirmation toasts reappear via observe + replay
 */

import { test, expect, type Page } from '@playwright/test';
import { ChatPage, HomePage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { stopAllActiveRunsFromHome } from '../helpers/cleanup';

function makeReproQuery(): string {
    return `repro pubsub reload ${Date.now()}`;
}

function uniqueQuery(base: string): string {
    return `${base} [e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}]`;
}

async function assertNoDuplicateThoughtMarkers(page: Page) {
    const markers = [
        'repro-shell-1',
        'repro-pattern-2',
        'repro-pattern-3',
        'repro-list-4',
        'repro-pattern-5',
    ];

    for (const marker of markers) {
        await expect(page.locator(Selectors.thoughtItem, { hasText: marker })).toHaveCount(1);
    }

    await expect(page.locator(Selectors.thoughtTool)).toHaveCount(markers.length);
}

test.describe('Reload During Active Run', () => {
    test('chat reload mid-run does not duplicate steps or re-show acknowledged confirmation', async ({ page }) => {
        const reproQuery = makeReproQuery();
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.startNewChat();
        await chatPage.waitForConnection();

        await chatPage.sendMessage(reproQuery);
        await chatPage.waitForProcessing();

        // Step 1 is confirmation-gated (shell_command)
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');
        await expect(chatPage.confirmationDialog).toHaveCount(0);

        // Ensure multiple steps have arrived and the run is still active before reload
        await chatPage.waitForThoughts();
        await chatPage.waitForThoughtCount(2);
        await expect(chatPage.stopButton).toBeVisible();

        // Reload during an active run
        await page.reload();
        await chatPage.waitForConnection();

        // Previously acknowledged confirmation must not re-appear after reload/replay
        await expect(chatPage.confirmationDialog).toHaveCount(0, { timeout: 5000 });

        // Run completes normally
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        await chatPage.expandThoughts();
        await assertNoDuplicateThoughtMarkers(page);
    });

    test('home reload mid-run does not duplicate steps or re-show acknowledged confirmation toast', async ({ page }) => {
        const reproQuery = makeReproQuery();
        const homePage = new HomePage(page);
        await homePage.goto();

        // Start as a background task so confirmations show as toasts on home.
        await homePage.sendBackgroundMessage(reproQuery);
        await homePage.waitForTaskWithTitle(reproQuery);

        const toast = page.locator(Selectors.confirmationToast, { hasText: reproQuery }).first();
        await toast.waitFor({ state: 'visible', timeout: 15000 });

        // Click "Yes" on the toast confirmation
        await toast.locator('.toast-actions .toast-btn.primary').click();
        await expect(page.locator(Selectors.confirmationToast, { hasText: reproQuery })).toHaveCount(0, { timeout: 15000 });

        // Ensure the confirmation was actually acknowledged by the server
        const firstCard = page.locator(Selectors.taskCard, { hasText: reproQuery }).first();
        await expect(firstCard).toBeVisible();
        await expect(firstCard.locator('.task-status-text.needs-input')).toHaveCount(0, { timeout: 15000 });
        await expect(firstCard.locator('.task-status-text.running')).toBeVisible({ timeout: 15000 });

        // Open the conversation (to capture the conversationId reliably)
        await firstCard.click();
        const chatPage = new ChatPage(page);
        await chatPage.waitForConnection();
        const conversationId = await chatPage.getConversationId();
        expect(conversationId).toBeTruthy();

        await expect(chatPage.confirmationDialog).toHaveCount(0, { timeout: 5000 });

        // Navigate back to home, then reload the home page mid-run
        await chatPage.goHome();
        await homePage.waitForConnection();
        await expect(page.locator(Selectors.taskCard, { hasText: reproQuery })).toBeVisible();

        await page.reload();
        await homePage.waitForConnection();

        // The acknowledged confirmation toast must not re-appear after reload
        await expect(page.locator(Selectors.confirmationToast)).toHaveCount(0, { timeout: 5000 });

        // Go back to the conversation and verify steps weren't duplicated on reload/replay
        await chatPage.gotoConversation(conversationId!);
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        await chatPage.expandThoughts();
        await assertNoDuplicateThoughtMarkers(page);
    });
});

test.describe('Task Card Persistence', () => {
    test.afterEach(async ({ page }) => {
        await stopAllActiveRunsFromHome(page);
    });

    test('running task card persists on home reload', async ({ page }) => {
        const homePage = new HomePage(page);
        await homePage.goto();

        const query = uniqueQuery('run a pausable analysis');
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);

        await page.waitForTimeout(500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await homePage.waitForConnection();

        await homePage.waitForTaskWithTitle(query);
        const card = homePage.getTaskCardByTitle(query);
        await expect(card).toBeVisible();
        await expect(card.locator('.task-status-text.running')).toBeVisible();
    });

    test('completed task card persists on home reload', async ({ page }) => {
        // Send as background so the user stays on home and never views the
        // conversation. Foreground completions are intentionally hidden from
        // the home gallery (the user already saw them finish in-place).
        const homePage = new HomePage(page);
        await homePage.goto();

        const query = uniqueQuery('list all files');
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);
        await expect(homePage.getTaskCardByTitle(query).locator('.task-status-text.completed')).toBeVisible({ timeout: 15000 });

        await page.waitForTimeout(500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await homePage.waitForConnection();

        await homePage.waitForTaskWithTitle(query);
        await expect(homePage.getTaskCardByTitle(query).locator('.task-status-text.completed')).toBeVisible();
    });
});

test.describe('Confirmation Persistence', () => {
    test('pending confirmation toast persists on home reload', async ({ page }) => {
        await page.addInitScript(() => {
            try {
                if (!window.sessionStorage.getItem('__e2e_storage_cleared__')) {
                    window.localStorage.clear();
                    window.sessionStorage.clear();
                    window.sessionStorage.setItem('__e2e_storage_cleared__', '1');
                }
            } catch {
                // ignore
            }
        });

        const reproQuery = makeReproQuery();
        const homePage = new HomePage(page);
        await homePage.goto();

        await homePage.sendBackgroundMessage(reproQuery);
        const taskCard = page.locator(Selectors.taskCard, { hasText: reproQuery });
        await expect(taskCard).toBeVisible({ timeout: 15000 });

        const toast = page.locator(Selectors.confirmationToast);
        await expect(toast.first()).toBeVisible({ timeout: 15000 });

        // Reload while the run is blocked on confirmation
        await page.waitForTimeout(250);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await homePage.waitForConnection();

        // The pending confirmation should be visible again after reload
        await expect(page.locator(Selectors.confirmationToast).first()).toBeVisible({ timeout: 15000 });

        // Cleanup: decline so the run finishes
        const noBtn = page
            .locator(Selectors.confirmationToast)
            .first()
            .locator('.toast-actions .toast-btn:has-text("No")');
        await expect(noBtn).toBeVisible({ timeout: 15000 });
        await noBtn.evaluate((el: HTMLElement) => el.click());
        await expect(page.locator(Selectors.confirmationToast)).toHaveCount(0, { timeout: 15000 });

        await stopAllActiveRunsFromHome(page);
    });
});
