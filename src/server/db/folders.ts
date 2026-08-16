/**
 * Conversation folder helpers, including built-in system folders.
 * System folders are identified by a stable `systemKey` per user; they are
 * created automatically and cannot be renamed, moved, or deleted.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './index';
import { ConversationFolder } from './schema';

export const AUTOMATIONS_FOLDER_KEY = 'automations';
export const AUTOMATIONS_FOLDER_NAME = 'Automations';

/**
 * Get the user's persistent "Automations" system folder, creating it if it
 * doesn't exist yet. Returns the folder ID.
 */
export async function getOrCreateAutomationsFolder(userId: number): Promise<string> {
    const [existing] = await db.select({ id: ConversationFolder.id })
        .from(ConversationFolder)
        .where(and(
            eq(ConversationFolder.userId, userId),
            eq(ConversationFolder.systemKey, AUTOMATIONS_FOLDER_KEY)
        ));
    if (existing) return existing.id;

    // Race-safe: the unique index on (user_id, system_key) makes concurrent
    // inserts a no-op, after which the folder is re-read.
    await db.insert(ConversationFolder)
        .values({ userId, name: AUTOMATIONS_FOLDER_NAME, systemKey: AUTOMATIONS_FOLDER_KEY })
        .onConflictDoNothing();

    const [folder] = await db.select({ id: ConversationFolder.id })
        .from(ConversationFolder)
        .where(and(
            eq(ConversationFolder.userId, userId),
            eq(ConversationFolder.systemKey, AUTOMATIONS_FOLDER_KEY)
        ));
    if (!folder) throw new Error('Failed to create Automations folder');
    return folder.id;
}
