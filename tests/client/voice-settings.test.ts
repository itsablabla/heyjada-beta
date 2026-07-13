import { test, expect, describe } from 'bun:test';
import { parseVoiceSettings } from '../../src/client/hooks/useVoiceSettings';

describe('parseVoiceSettings', () => {
    test('off preserves the last on-mode for the re-enable tap', () => {
        expect(parseVoiceSettings('{"v":1,"mode":"off","lastActiveMode":"speak_freely"}'))
            .toEqual({ mode: 'off', lastActiveMode: 'speak_freely' });
    });

    test('hand-edited or stale payloads never yield an invalid state', () => {
        expect(parseVoiceSettings('{"v":1,"mode":"shout","lastActiveMode":"whisper"}'))
            .toEqual({ mode: 'off', lastActiveMode: 'ask_first' });
        expect(parseVoiceSettings('{"v":1,"enabled":true}'))
            .toEqual({ mode: 'off', lastActiveMode: 'ask_first' });
        expect(parseVoiceSettings('not json'))
            .toEqual({ mode: 'off', lastActiveMode: 'ask_first' });
    });
});
