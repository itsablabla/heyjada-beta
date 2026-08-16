import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    sanitizeAutomationFolderName,
    getAutomationOutputDir,
    ensureAutomationOutputDir,
} from '../../src/server/automation/output-dir';
import { getAutomationsDir } from '../../src/server/paths';

describe('Automation output directory', () => {
    let tmpDir: string;
    let previousEnv: string | undefined;

    beforeEach(() => {
        previousEnv = process.env.PIPALI_AUTOMATIONS_DIR;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipali-automations-test-'));
        process.env.PIPALI_AUTOMATIONS_DIR = tmpDir;
    });

    afterEach(() => {
        if (previousEnv === undefined) {
            delete process.env.PIPALI_AUTOMATIONS_DIR;
        } else {
            process.env.PIPALI_AUTOMATIONS_DIR = previousEnv;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('sanitizeAutomationFolderName', () => {
        test('keeps safe characters', () => {
            expect(sanitizeAutomationFolderName('Weekly Report 2', 'id')).toBe('Weekly Report 2');
        });

        test('strips path separators and unsafe characters', () => {
            expect(sanitizeAutomationFolderName('../../etc/passwd', 'id')).toBe('etcpasswd');
            expect(sanitizeAutomationFolderName('a/b\\c:d*e', 'id')).toBe('abcde');
        });

        test('falls back to id when name has no usable characters', () => {
            expect(sanitizeAutomationFolderName('///***', 'some-id')).toBe('some-id');
            expect(sanitizeAutomationFolderName('   ', 'some-id')).toBe('some-id');
        });

        test('collapses whitespace', () => {
            expect(sanitizeAutomationFolderName('My   Automation', 'id')).toBe('My Automation');
        });
    });

    describe('getAutomationsDir', () => {
        test('respects PIPALI_AUTOMATIONS_DIR override', () => {
            expect(getAutomationsDir()).toBe(tmpDir);
        });

        test('defaults to ~/HeyJada/Automations', () => {
            delete process.env.PIPALI_AUTOMATIONS_DIR;
            expect(getAutomationsDir()).toBe(path.join(os.homedir(), 'HeyJada', 'Automations'));
        });
    });

    describe('getAutomationOutputDir', () => {
        test('returns per-automation subfolder', () => {
            const dir = getAutomationOutputDir({ id: 'abc', name: 'Weekly Report' });
            expect(dir).toBe(path.join(tmpDir, 'Weekly Report'));
        });

        test('stays inside base dir for malicious names', () => {
            const dir = getAutomationOutputDir({ id: 'abc', name: '../../escape' });
            expect(dir.startsWith(tmpDir + path.sep)).toBe(true);
        });
    });

    describe('ensureAutomationOutputDir', () => {
        test('creates the folder if missing', () => {
            const dir = ensureAutomationOutputDir({ id: 'abc', name: 'My Automation' });
            expect(fs.existsSync(dir)).toBe(true);
            expect(fs.statSync(dir).isDirectory()).toBe(true);
        });

        test('recreates the folder after deletion (persistent)', () => {
            const dir = ensureAutomationOutputDir({ id: 'abc', name: 'My Automation' });
            fs.rmSync(dir, { recursive: true, force: true });
            const dir2 = ensureAutomationOutputDir({ id: 'abc', name: 'My Automation' });
            expect(dir2).toBe(dir);
            expect(fs.existsSync(dir2)).toBe(true);
        });
    });
});
