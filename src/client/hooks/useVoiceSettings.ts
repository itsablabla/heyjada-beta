import { useSyncExternalStore, useCallback } from 'react';
import type { VoiceMode } from '../utils/voice-config';

/**
 * Per-device voice settings. `mode` is the tri-state voice control: off, or one
 * of the two speaking etiquettes (ask_first / speak_freely). `lastActiveMode`
 * remembers the on-mode a plain "voice on" toggle should return to. Distinct
 * from OS microphone permission (which only grants capture) and persisted so
 * the "enable and walk away" flow survives reloads/reconnects while the user
 * is away from the screen.
 *
 * Backed by a tiny shared store so every hook instance in the window stays in
 * sync (same-window writes don't fire `storage` events); the `storage` listener
 * covers other tabs. The versioned envelope leaves room for future fields.
 */

export interface VoiceSettings {
    mode: VoiceMode;
    lastActiveMode: Exclude<VoiceMode, 'off'>;
}

const STORAGE_KEY = 'pipali.voiceSettings.v1';
const DEFAULTS: VoiceSettings = { mode: 'off', lastActiveMode: 'ask_first' };

type PersistedV1 = { v: 1 } & VoiceSettings;

/** Parse a persisted payload; anything unrecognized degrades to defaults. */
export function parseVoiceSettings(raw: string | null): VoiceSettings {
    if (!raw) return DEFAULTS;
    try {
        const parsed = JSON.parse(raw) as PersistedV1 | null;
        if (parsed?.v !== 1) return DEFAULTS;
        const mode = parsed.mode === 'ask_first' || parsed.mode === 'speak_freely' || parsed.mode === 'off'
            ? parsed.mode : 'off';
        const last = parsed.lastActiveMode === 'speak_freely' ? 'speak_freely' : 'ask_first';
        return { mode, lastActiveMode: mode !== 'off' ? mode : last };
    } catch {
        return DEFAULTS;
    }
}

function read(): VoiceSettings {
    if (typeof window === 'undefined') return DEFAULTS;
    try {
        return parseVoiceSettings(window.localStorage.getItem(STORAGE_KEY));
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

function setMode(mode: VoiceMode): void {
    if (current.mode === mode) return;
    current = { mode, lastActiveMode: mode !== 'off' ? mode : current.lastActiveMode };
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
    return { ...settings, setMode: useCallback(setMode, []) };
}
