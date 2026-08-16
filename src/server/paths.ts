/**
 * Cross-platform application paths utility
 * Provides platform-appropriate directories for storing user data
 */

import path from 'path';
import os from 'os';
import fs from 'fs';

const APP_NAME = 'pipali';

/**
 * Get the base application data directory
 * - macOS: ~/Library/Application Support/pipali
 * - Windows: %APPDATA%/pipali
 * - Linux: ~/.local/share/pipali (or XDG_DATA_HOME/pipali)
 */
export function getAppDataDir(): string {
    if (process.env.PIPALI_DATA_DIR) {
        return process.env.PIPALI_DATA_DIR;
    }

    const platform = process.platform;
    const home = os.homedir();

    switch (platform) {
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', APP_NAME);
        case 'win32':
            return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
        default:
            // Linux and other Unix-like systems
            const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
            return path.join(xdgDataHome, APP_NAME);
    }
}

/**
 * Get the application config directory
 * - macOS: ~/Library/Application Support/pipali (same as data)
 * - Windows: %APPDATA%/pipali (same as data)
 * - Linux: ~/.config/pipali (or XDG_CONFIG_HOME/pipali)
 */
export function getAppConfigDir(): string {
    if (process.env.PIPALI_CONFIG_DIR) {
        return process.env.PIPALI_CONFIG_DIR;
    }

    const platform = process.platform;
    const home = os.homedir();

    switch (platform) {
        case 'darwin':
        case 'win32':
            // On macOS and Windows, config and data are in the same location
            return getAppDataDir();
        default:
            // Linux and other Unix-like systems use XDG spec
            const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
            return path.join(xdgConfigHome, APP_NAME);
    }
}

/**
 * Get the application cache directory
 * - macOS: ~/Library/Caches/pipali
 * - Windows: %LOCALAPPDATA%/pipali/cache
 * - Linux: ~/.cache/pipali (or XDG_CACHE_HOME/pipali)
 */
export function getAppCacheDir(): string {
    if (process.env.PIPALI_CACHE_DIR) {
        return process.env.PIPALI_CACHE_DIR;
    }

    const platform = process.platform;
    const home = os.homedir();

    switch (platform) {
        case 'darwin':
            return path.join(home, 'Library', 'Caches', APP_NAME);
        case 'win32':
            return path.join(
                process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
                APP_NAME,
                'cache'
            );
        default:
            // Linux and other Unix-like systems
            const xdgCacheHome = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
            return path.join(xdgCacheHome, APP_NAME);
    }
}

/**
 * Get the application logs directory
 * - macOS: ~/Library/Logs/pipali
 * - Windows: %LOCALAPPDATA%/pipali/logs
 * - Linux: ~/.local/state/pipali/logs (or XDG_STATE_HOME/pipali/logs)
 */
export function getAppLogsDir(): string {
    if (process.env.PIPALI_LOGS_DIR) {
        return process.env.PIPALI_LOGS_DIR;
    }

    const platform = process.platform;
    const home = os.homedir();

    switch (platform) {
        case 'darwin':
            return path.join(home, 'Library', 'Logs', APP_NAME);
        case 'win32':
            return path.join(
                process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
                APP_NAME,
                'logs'
            );
        default:
            // Linux and other Unix-like systems
            const xdgStateHome = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
            return path.join(xdgStateHome, APP_NAME, 'logs');
    }
}

/**
 * Get the database directory path
 * Creates the directory if it doesn't exist
 */
export function getDatabaseDir(): string {
    const dbDir = path.join(getAppDataDir(), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    return dbDir;
}

/**
 * Get the default automations output directory path
 * A user-visible, persistent folder where files created by automations
 * are placed by default (each automation gets its own subfolder).
 */
export function getAutomationsDir(): string {
    if (process.env.PIPALI_AUTOMATIONS_DIR) {
        return process.env.PIPALI_AUTOMATIONS_DIR;
    }
    return path.join(os.homedir(), 'HeyJada', 'Automations');
}

/**
 * Get the automations output directory, creating it if it doesn't exist
 */
export function ensureAutomationsDir(): string {
    const dir = getAutomationsDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Get the skills directory path
 * Note: Skills currently use ~/.pipali/skills for backwards compatibility
 * This will be migrated to use getAppDataDir() in a future release
 */
export function getSkillsDir(): string {
    if (process.env.PIPALI_SKILLS_DIR) {
        return process.env.PIPALI_SKILLS_DIR;
    }
    return path.join(os.homedir(), '.pipali', 'skills');
}
