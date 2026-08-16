/**
 * Automation Output Directory
 *
 * Provides a default, persistent folder where files created by automations
 * are placed. Each automation gets its own subfolder (derived from its name)
 * inside the base automations directory.
 */

import path from 'path';
import fs from 'fs';
import { getAutomationsDir, ensureAutomationsDir } from '../paths';

/**
 * Sanitize an automation name into a safe folder name.
 * Falls back to the automation id if the name has no usable characters.
 */
export function sanitizeAutomationFolderName(name: string, fallback: string): string {
    const sanitized = name
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim()
        .replace(/\s+/g, ' ');
    return sanitized || fallback;
}

/**
 * Get the output directory path for a specific automation
 */
export function getAutomationOutputDir(automation: { id: string; name: string }): string {
    const folderName = sanitizeAutomationFolderName(automation.name, automation.id);
    return path.join(getAutomationsDir(), folderName);
}

/**
 * Get the output directory for a specific automation, creating it
 * (and the base automations directory) if it doesn't exist
 */
export function ensureAutomationOutputDir(automation: { id: string; name: string }): string {
    ensureAutomationsDir();
    const dir = getAutomationOutputDir(automation);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
