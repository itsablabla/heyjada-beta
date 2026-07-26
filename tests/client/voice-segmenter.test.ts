import { test, expect, describe } from 'bun:test';
import { SpeechSegmenter, EnergyVad, type SegmenterConfig, type SegmenterEvent } from '../../src/client/utils/voice/voice-segmenter';
import { downsample, encodeWavPcm16 } from '../../src/client/utils/voice/voice-pcm';

// 16kHz, 30ms frames = 480 samples. Thresholds in whole frames for easy math.
const CONFIG: SegmenterConfig = {
    sampleRate: 16_000,
    frameSamples: 480,
    preRollMs: 90,        // 3 frames
    speechStartFrames: 2, // 2 voiced of the last 3 frames opens a segment
    speechStartWindow: 3,
    silenceEndMs: 90,     // 3 frames
    minSpeechMs: 90,      // 3 voiced frames
    maxSegmentMs: 600,    // 20 frames
};

const silent = () => new Float32Array(480);
const voiced = () => new Float32Array(480).fill(0.1);

function feed(segmenter: SpeechSegmenter, frames: Float32Array[]): SegmenterEvent[] {
    return frames.flatMap((f) => segmenter.pushFrame(f));
}

function makeSegmenter() {
    return new SpeechSegmenter(CONFIG, new EnergyVad());
}

describe('SpeechSegmenter', () => {
    test('a single voiced frame does not open a segment (hysteresis)', () => {
        const s = makeSegmenter();
        const events = feed(s, [silent(), voiced(), silent(), silent()]);
        expect(events).toEqual([]);
    });

    test('choppy onset (voiced-dip-voiced, like "send it") still opens a segment', () => {
        // Consonant dips reset a strictly-consecutive counter; the majority
        // window (2 of 3 here) tolerates them at normal speaking volume.
        const s = makeSegmenter();
        const events = feed(s, [
            voiced(), silent(), voiced(),       // onset fires on the 3rd frame
            voiced(),
            silent(), silent(), silent(),       // pause closes the segment
        ]);
        expect(events[0]).toEqual({ type: 'speech_start' });
        expect(events[1]?.type).toBe('segment');
    });

    test('sustained speech opens a segment; a pause closes it', () => {
        const s = makeSegmenter();
        const events = feed(s, [
            silent(), silent(),            // ambient
            voiced(), voiced(),            // onset (hysteresis = 2)
            voiced(), voiced(),            // speech
            silent(), silent(), silent(),  // pause (3 frames) closes the segment
        ]);
        expect(events[0]).toEqual({ type: 'speech_start' });
        const seg = events[1]!;
        if (seg.type !== 'segment') throw new Error(`expected segment, got ${seg.type}`);
        // 2 pre-roll/hysteresis-adjacent + 2 onset... pre-roll holds the last 3
        // frames at onset (silent, voiced, voiced), then 2 voiced + 3 silent follow.
        expect(seg.samples.length).toBe(8 * 480);
    });

    test('segment includes pre-roll audio from before onset', () => {
        const s = makeSegmenter();
        // Mark pre-onset frames with a distinct value to find them in the output.
        const marked = new Float32Array(480).fill(0.001); // below threshold: unvoiced
        const events = feed(s, [
            marked, marked,
            voiced(), voiced(), voiced(),
            silent(), silent(), silent(),
        ]);
        const seg = events.find((e) => e.type === 'segment');
        if (!seg || seg.type !== 'segment') throw new Error('no segment');
        expect(seg.samples[0]).toBeCloseTo(0.001, 6);
    });

    test('a short blip is rejected, not emitted', () => {
        const s = makeSegmenter();
        const events = feed(s, [
            voiced(), voiced(),            // opens (2 voiced) but min is 3
            silent(), silent(), silent(),
        ]);
        expect(events).toEqual([
            { type: 'speech_start' },
            { type: 'segment_rejected', reason: 'too_short' },
        ]);
    });

    test('an over-long segment is force-closed at the cap', () => {
        const s = makeSegmenter();
        const events = feed(s, Array.from({ length: 30 }, voiced));
        const seg = events.find((e) => e.type === 'segment');
        if (!seg || seg.type !== 'segment') throw new Error('no segment');
        expect(seg.samples.length).toBeLessThanOrEqual(20 * 480);
    });

    test('flush force-closes an open segment (tap-to-end)', () => {
        const s = makeSegmenter();
        feed(s, [voiced(), voiced(), voiced(), voiced()]);
        const events = s.flush();
        expect(events).toHaveLength(1);
        expect(events[0]!.type).toBe('segment');
    });

    test('flush with no open segment is a no-op', () => {
        const s = makeSegmenter();
        feed(s, [silent(), silent()]);
        expect(s.flush()).toEqual([]);
    });
});

describe('listening through Pipali speaking', () => {
    const quiet = () => new Float32Array(480).fill(0.025);   // between the two thresholds

    test('a raised bar applies while Pipali speaks', () => {
        const vad = new EnergyVad();
        expect(vad.isVoiced(quiet())).toBe(true);            // ordinary listening
        expect(vad.isVoiced(quiet(), true)).toBe(false);     // could be its own echo
        expect(vad.isVoiced(voiced(), true)).toBe(true);     // ordinary speech still carries
    });

    test('a segment that caught the tail of a readout is flagged', () => {
        // The flag has to travel with the audio: a segment closes ~900ms after
        // the voice in it stops, so by the time it is handed over the readout
        // has usually ended and "is Pipali speaking?" reads false.
        const s = makeSegmenter();
        s.setSpeaking(true);
        feed(s, [voiced(), voiced(), voiced()]);
        s.setSpeaking(false);
        const events = feed(s, [silent(), silent(), silent()]);
        const seg = events.find((e) => e.type === 'segment');
        if (!seg || seg.type !== 'segment') throw new Error('no segment');
        expect(seg.overlappedPlayback).toBe(true);
    });

    test('a segment captured in silence is not flagged', () => {
        const s = makeSegmenter();
        const events = feed(s, [voiced(), voiced(), voiced(), silent(), silent(), silent()]);
        const seg = events.find((e) => e.type === 'segment');
        if (!seg || seg.type !== 'segment') throw new Error('no segment');
        expect(seg.overlappedPlayback).toBe(false);
    });
});

describe('voice-pcm', () => {
    test('downsample 48k to 16k yields a third of the samples', () => {
        const input = new Float32Array(4800).fill(0.5);
        const out = downsample(input, 48_000, 16_000);
        expect(out.length).toBe(1600);
        expect(out[0]).toBeCloseTo(0.5, 6);
    });

    test('downsample at equal rates is identity', () => {
        const input = new Float32Array([0.1, 0.2]);
        expect(downsample(input, 16_000, 16_000)).toBe(input);
    });

    test('encodeWavPcm16 writes a valid header and 16-bit data', () => {
        const wav = encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1]), 16_000);
        expect(wav.length).toBe(44 + 8);
        const ascii = (start: number, len: number) => String.fromCharCode(...wav.slice(start, start + len));
        expect(ascii(0, 4)).toBe('RIFF');
        expect(ascii(8, 4)).toBe('WAVE');
        const view = new DataView(wav.buffer);
        expect(view.getUint32(24, true)).toBe(16_000);            // sample rate
        expect(view.getInt16(44 + 2, true)).toBe(Math.floor(0.5 * 0x7fff)); // 0.5 sample (setInt16 truncates)
        expect(view.getInt16(44 + 6, true)).toBe(0x7fff);          // clamped 1.0
    });
});
