import { useSyncExternalStore, useCallback } from 'react';

/**
 * Per-device voice settings. v1 holds a single field — `enabled` — the master
 * voice-mode toggle. It is distinct from OS microphone permission (which only
 * grants capture) and persisted so the "enable and walk away" flow survives the
 * reloads/reconnects that happen while the user is away from the screen.
 *
 * Backed by a tiny shared store so every hook instance in the window stays in
 * sync (same-window writes don't fire `storage` events); the `storage` listener
 * covers other tabs. The versioned envelope leaves room for future fields.
 */

export interface VoiceSettings {
    enabled: boolean;
}

const STORAGE_KEY = 'pipali.voiceSettings.v1';
const DEFAULTS: VoiceSettings = { enabled: false };

type PersistedV1 = { v: 1 } & VoiceSettings;

function read(): VoiceSettings {
    if (typeof window === 'undefined') return DEFAULTS;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULTS;
        const parsed = JSON.parse(raw) as PersistedV1;
        if (!parsed || parsed.v !== 1) return DEFAULTS;
        return { enabled: !!parsed.enabled };
    } catch {
        return DEFAULTS;
    }
}

let current: VoiceSettings = read();
const subscribers = new Set<() => void>();

function emit(): void {
    for (const fn of subscribers) fn();
}

function subscribe(cb: () => void): () => void {
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
}

// Sync across tabs.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
            current = read();
            emit();
        }
    });
}

function setEnabled(enabled: boolean): void {
    if (current.enabled === enabled) return;
    current = { ...current, enabled };
    try {
        const payload: PersistedV1 = { v: 1, ...current };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // ignore quota / private-mode failures
    }
    emit();
}

export function useVoiceSettings() {
    const settings = useSyncExternalStore(subscribe, () => current, () => DEFAULTS);
    return { ...settings, setEnabled: useCallback(setEnabled, []) };
}
