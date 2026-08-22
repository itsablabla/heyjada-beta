import fs from 'fs';
import path from 'path';
import webpush, { type WebPushSubscription, type VapidKeys } from 'web-push';
import { getAppDataDir } from '../paths';
import { createChildLogger } from '../logger';
import { atifConversationService } from '../processor/conversation/atif/atif.service';
import type { ConfirmationRequest } from '../processor/confirmation/confirmation.types';

const log = createChildLogger({ component: 'push' });

const DEFAULT_DELAY_SECONDS = 10;
const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 60 * 60;
const VAPID_SUBJECT = process.env.SUPERJOY_VAPID_SUBJECT || 'mailto:noreply@superjoy.ai';

interface StoredSubscription {
    endpoint: string;
    subscription: WebPushSubscription;
    enabled: boolean;
    delaySeconds: number;
    updatedAt: string;
}

type SubscriptionStore = Record<string, StoredSubscription>;

interface ScheduledConfirmationPush {
    cancel(): void;
}

function getPushDir(): string {
    const dir = path.join(getAppDataDir(), 'push');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getVapidKeysPath(): string {
    return path.join(getPushDir(), 'vapid-keys.json');
}

function getSubscriptionsPath(): string {
    return path.join(getPushDir(), 'subscriptions.json');
}

function normalizeDelaySeconds(value: unknown): number {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_DELAY_SECONDS;
    return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, numeric));
}

function readStoredVapidKeys(): VapidKeys | null {
    try {
        if (!fs.existsSync(getVapidKeysPath())) return null;
        const parsed = JSON.parse(fs.readFileSync(getVapidKeysPath(), 'utf-8')) as Partial<VapidKeys>;
        if (parsed.publicKey && parsed.privateKey) {
            return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        }
    } catch (error) {
        log.warn({ err: error }, 'Failed to read VAPID keys');
    }
    return null;
}

function loadOrCreateVapidKeys(): VapidKeys {
    const envPublicKey = process.env.SUPERJOY_VAPID_PUBLIC_KEY?.trim();
    const envPrivateKey = process.env.SUPERJOY_VAPID_PRIVATE_KEY?.trim();
    if (envPublicKey && envPrivateKey) {
        return { publicKey: envPublicKey, privateKey: envPrivateKey };
    }

    const stored = readStoredVapidKeys();
    if (stored) return stored;

    const generated = webpush.generateVAPIDKeys();
    fs.writeFileSync(getVapidKeysPath(), JSON.stringify(generated, null, 2));
    return generated;
}

function configureWebPush(): VapidKeys {
    const keys = loadOrCreateVapidKeys();
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    return keys;
}

export function getVapidPublicKey(): string {
    return configureWebPush().publicKey;
}

async function readSubscriptions(): Promise<SubscriptionStore> {
    try {
        const filePath = getSubscriptionsPath();
        if (!fs.existsSync(filePath)) return {};
        const parsed = JSON.parse(await Bun.file(filePath).text()) as SubscriptionStore;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        log.warn({ err: error }, 'Failed to read push subscriptions');
        return {};
    }
}

async function writeSubscriptions(store: SubscriptionStore): Promise<void> {
    await Bun.write(getSubscriptionsPath(), JSON.stringify(store, null, 2));
}

export async function savePushSubscription(input: {
    subscription: WebPushSubscription;
    enabled?: boolean;
    delaySeconds?: number;
}): Promise<StoredSubscription> {
    const store = await readSubscriptions();
    const endpoint = input.subscription.endpoint;
    const stored: StoredSubscription = {
        endpoint,
        subscription: input.subscription,
        enabled: input.enabled !== false,
        delaySeconds: normalizeDelaySeconds(input.delaySeconds),
        updatedAt: new Date().toISOString(),
    };
    store[endpoint] = stored;
    await writeSubscriptions(store);
    return stored;
}

export async function removePushSubscription(endpoint: string): Promise<void> {
    const store = await readSubscriptions();
    delete store[endpoint];
    await writeSubscriptions(store);
}

function summarizeRequest(request: ConfirmationRequest): string {
    const text = request.question || request.message || request.title || 'Approval is needed to continue.';
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 140) return normalized;
    return `${normalized.slice(0, 139)}…`;
}

async function getConversationTitle(conversationId: string): Promise<string> {
    try {
        const conversation = await atifConversationService.getConversation(conversationId);
        const title = conversation?.title?.trim();
        if (title) return title;
    } catch (error) {
        log.warn({ err: error, conversationId }, 'Failed to load conversation title for push notification');
    }
    return 'Superjoy needs approval';
}

async function sendToSubscription(
    stored: StoredSubscription,
    payload: { conversationId: string; title: string; body: string }
): Promise<void> {
    configureWebPush();

    try {
        await webpush.sendNotification(stored.subscription, JSON.stringify(payload), {
            TTL: 60,
            urgency: 'high',
        });
    } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : undefined;
        if (statusCode === 404 || statusCode === 410) {
            await removePushSubscription(stored.endpoint);
            return;
        }
        log.warn({ err: error, endpoint: stored.endpoint }, 'Failed to send push notification');
    }
}

export function scheduleConfirmationPush(
    conversationId: string | undefined,
    request: ConfirmationRequest
): ScheduledConfirmationPush {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let cancelled = false;

    if (!conversationId) {
        return { cancel: () => { cancelled = true; } };
    }

    void (async () => {
        const store = await readSubscriptions();
        const subscriptions = Object.values(store).filter(subscription => subscription.enabled);
        if (cancelled || subscriptions.length === 0) return;

        for (const subscription of subscriptions) {
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (cancelled) return;
                void (async () => {
                    const title = await getConversationTitle(conversationId);
                    if (!cancelled) {
                        await sendToSubscription(subscription, {
                            conversationId,
                            title,
                            body: summarizeRequest(request),
                        });
                    }
                })().catch(error => {
                    log.warn({ err: error, conversationId, requestId: request.requestId }, 'Failed to send scheduled push notification');
                });
            }, normalizeDelaySeconds(subscription.delaySeconds) * 1000);
            timers.add(timer);
        }
    })().catch(error => {
        log.warn({ err: error, conversationId, requestId: request.requestId }, 'Failed to schedule push notification');
    });

    return {
        cancel: () => {
            cancelled = true;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
        },
    };
}
