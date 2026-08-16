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
    const overrideDataDir = process.env.HEYJADA_DATA_DIR || process.env.PIPALI_DATA_DIR;
    if (overrideDataDir) {
        return overrideDataDir;
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
    const overrideConfigDir = process.env.HEYJADA_CONFIG_DIR || process.env.PIPALI_CONFIG_DIR;
    if (overrideConfigDir) {
        return overrideConfigDir;
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
    const overrideCacheDir = process.env.HEYJADA_CACHE_DIR || process.env.PIPALI_CACHE_DIR;
    if (overrideCacheDir) {
        return overrideCacheDir;
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
    const overrideLogsDir = process.env.HEYJADA_LOGS_DIR || process.env.PIPALI_LOGS_DIR;
    if (overrideLogsDir) {
        return overrideLogsDir;
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
 * Get the skills directory path
 * Note: Skills currently use ~/.pipali/skills for backwards compatibility
 * This will be migrated to use getAppDataDir() in a future release
 */
export function getSkillsDir(): string {
    const overrideSkillsDir = process.env.HEYJADA_SKILLS_DIR || process.env.PIPALI_SKILLS_DIR;
    if (overrideSkillsDir) {
        return overrideSkillsDir;
    }
    return path.join(os.homedir(), '.pipali', 'skills');
}
