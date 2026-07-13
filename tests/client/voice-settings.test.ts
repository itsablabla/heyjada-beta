import { test, expect, describe } from 'bun:test';
import { parseVoiceSettings } from '../../src/client/hooks/useVoiceSettings';

describe('parseVoiceSettings', () => {
    test('feature flag off forces mode off, so re-enabling never surprise-starts the mic', () => {
        expect(parseVoiceSettings('{"v":1,"enabled":false,"mode":"speak_freely","lastActiveMode":"speak_freely"}'))
            .toEqual({ enabled: false, mode: 'off', lastActiveMode: 'speak_freely' });
    });

    test('off mode preserves the last on-mode for the re-enable tap', () => {
        expect(parseVoiceSettings('{"v":1,"enabled":true,"mode":"off","lastActiveMode":"speak_freely"}'))
            .toEqual({ enabled: true, mode: 'off', lastActiveMode: 'speak_freely' });
    });

    test('hand-edited or stale payloads never yield an invalid state', () => {
        expect(parseVoiceSettings('{"v":1,"enabled":true,"mode":"shout","lastActiveMode":"whisper"}'))
            .toEqual({ enabled: true, mode: 'off', lastActiveMode: 'ask_first' });
        expect(parseVoiceSettings('{"v":1,"enabled":true}'))
            .toEqual({ enabled: true, mode: 'off', lastActiveMode: 'ask_first' });
        expect(parseVoiceSettings('not json'))
            .toEqual({ enabled: false, mode: 'off', lastActiveMode: 'ask_first' });
    });
});
