/**
 * Background Command Tests
 *
 * A shell command marked run_in_background outlives the tool call that started it.
 * The turn ends immediately, the command's output goes to a log file, and the
 * conversation is told when it exits - the same inbox delegated tasks report through.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { stopAllActiveConversations, stopAllActiveRunsFromHome } from '../helpers/cleanup';

type SystemStep = { source: string; message?: string; extra?: { kind?: string } };

async function backgroundUpdates(request: APIRequestContext, conversationId: string): Promise<SystemStep[]> {
    const res = await request.get(`/api/chat/${conversationId}/history`);
    const { history } = await res.json() as { history: SystemStep[] };
    return history.filter(s => s.source === 'system' && s.extra?.kind === 'background_command_update');
}

test.describe('Background commands', () => {
    test.afterEach(async ({ page, request }) => {
        await stopAllActiveConversations(page, request);
        await stopAllActiveRunsFromHome(page);
    });

    test('the turn ends before the command does, then its exit is reported', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('run something in the background');

        const conversationId = await chatPage.waitForConversationId();

        // Backgrounding does not skip approval - confirmation happens before the spawn.
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');

        // The turn does not block on a command that takes seconds.
        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('running in the background', { timeout: 15000 });
        await expect.poll(
            () => chatPage.isProcessing(),
            { timeout: 15000, message: 'expected the turn to end while the command runs' },
        ).toBe(false);

        // The command reports itself when it exits, without the user asking.
        await expect.poll(
            async () => (await backgroundUpdates(request, conversationId)).length,
            { timeout: 30000, message: 'expected the command to report its exit' },
        ).toBeGreaterThan(0);

        const [update] = await backgroundUpdates(request, conversationId);
        expect(update!.message).toContain('[Background command finished]');
        // Output written after the tool call returned still reaches the conversation.
        expect(update!.message).toContain('done-in-background');
    });

    test('stopping a command it started does not make it answer twice', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('start and stop something in the background');

        const conversationId = await chatPage.waitForConversationId();
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');

        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('stopped it again', { timeout: 20000 });
        await expect.poll(
            () => chatPage.isProcessing(),
            { timeout: 20000, message: 'expected the turn to end' },
        ).toBe(false);

        const responsesAfterAnswering = await chatPage.getMessageCount();

        // The kill produces an exit event of its own. Reporting it would wake the
        // conversation to announce a stop it had just carried out itself.
        await page.waitForTimeout(6000);
        expect(await chatPage.isProcessing()).toBe(false);
        expect(await chatPage.getMessageCount()).toEqual(responsesAfterAnswering);
        expect(await backgroundUpdates(request, conversationId)).toHaveLength(0);
    });
});
