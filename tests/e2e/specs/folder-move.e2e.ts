/**
 * Folder Move Persistence Test
 *
 * Regression test for chats "popping back out" of folders: an optimistic
 * folder move must survive the conversation-list refetches fired by
 * websocket stream events (run started, task complete, etc.).
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

// Matches the slow-pausable mock scenario (~10s of streamed iterations)
const STREAMING_QUERY = 'run a pausable analysis';

test.describe('Folder Move Persistence', () => {
    test('a streaming chat moved into a folder stays there after stream events and refetches', async ({ page, context }) => {
        const chatPage = new ChatPage(page);
        await context.clearCookies();

        await page.goto('/');
        await chatPage.waitForConnection();

        // ============================================
        // 1. Create a folder (sidebar prompt dialog)
        // ============================================
        const folderName = `E2E Folder ${Date.now()}`;
        page.once('dialog', dialog => void dialog.accept(folderName));
        await page.locator('.sidebar .section-icon-btn').click();

        const folderRow = page.locator('.folder-row', { hasText: folderName });
        await expect(folderRow).toBeVisible();

        // ============================================
        // 2. Start a chat that streams for a while
        // ============================================
        await chatPage.sendMessage(STREAMING_QUERY);
        await chatPage.waitForProcessing();

        // The streaming conversation shows up in the sidebar root list
        const activeItem = page.locator('.conversations-list > .conversation-item.has-active-task');
        await expect(activeItem).toBeVisible();

        // ============================================
        // 3. Move the still-streaming chat into the folder via the context menu
        // ============================================
        await activeItem.hover();
        await activeItem.locator('.menu-btn').click();

        const moveItem = page.locator('.conversation-menu .conversation-menu-item', { hasText: 'Move to folder' });
        await moveItem.click();

        await page
            .locator('.folder-move-submenu .conversation-menu-item', { hasText: folderName })
            .click();

        // The folder auto-expands and now contains the chat...
        const folderChild = page.locator('.folder-children .conversation-item');
        await expect(folderChild).toHaveCount(1);
        // ...and the chat left the unfiled root list
        await expect(page.locator('.conversations-list > .conversation-item.has-active-task')).toHaveCount(0);

        // ============================================
        // 4. Stream events fire list refetches while the run continues;
        //    the chat must not pop back out of the folder.
        // ============================================
        await page.waitForTimeout(2000);
        await expect(folderChild).toHaveCount(1);
        await expect(page.locator('.conversations-list > .conversation-item')).toHaveCount(0);

        // ============================================
        // 5. Wait for the stream to finish (task-complete triggers another
        //    refetch) and assert the chat is still filed in the folder.
        // ============================================
        await chatPage.waitForIdle();
        // Give any in-flight (potentially stale) refetches time to resolve
        await page.waitForTimeout(1500);

        await expect(folderChild).toHaveCount(1);
        await expect(page.locator('.conversations-list > .conversation-item')).toHaveCount(0);
    });
});
