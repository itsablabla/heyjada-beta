/**
 * Turn transcript assembly for segmented hands-free speech.
 *
 * Segments transcribe concurrently and may resolve out of order; the assembler
 * appends them in sequence order and re-checks the transcript tail whenever the
 * contiguous prefix grows. The turn ends only on a tail-position end phrase
 * (or discard phrase) — silence never ends a turn.
 *
 * Pure: strings in, actions out. No audio or network.
 */

import { normalizeUtterance } from './voice-intent';
import { END_PHRASES, DISCARD_PHRASES, CANCEL_PHRASES, STT_BIAS_PROMPT } from './voice-config';

// Whisper-family models hallucinate fixed phrases on noise-only audio.
// Conservative full-string matches only — never drop real dictation.
const HALLUCINATION_PATTERNS: RegExp[] = [
    /^thank you[.!]?$/i,
    /^thanks?[.!]?$/i,
    /^thanks? for watching[\s\S]*$/i,
    /^thank you for watching[\s\S]*$/i,
    /^please (like and )?subscribe[\s\S]*$/i,
    /^subtitles? by[\s\S]*$/i,
    /^\[?(blank[_ ]?audio|silence|music|inaudible)\]?[.!]?$/i,
    /^you[.!]?$/i,
    /^[.\s]*$/,
    // "hey pipali" was here as a suspected prompt echo, but it is the documented
    // wake phrase — blocking it meant the one thing the UI teaches did nothing.
    // The min-speech gate already drops noise-only audio, and a bare address can
    // only open a listening turn: visible, and destructive of nothing.
];

// Whisper also echoes its conditioning text on noise-only audio. Derived from
// the live prompt so rewording can't drift; the token floor keeps short
// utterances that appear in the prompt ("send it") usable as commands.
const NORMALIZED_BIAS_PROMPT = normalizeUtterance(STT_BIAS_PROMPT);
const PROMPT_ECHO_MIN_TOKENS = 5;

function isPromptEcho(text: string): boolean {
    const normalized = normalizeUtterance(text);
    if (!normalized || normalized.split(' ').length < PROMPT_ECHO_MIN_TOKENS) return false;
    return NORMALIZED_BIAS_PROMPT.includes(normalized);
}

export function isHallucination(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    return isPromptEcho(t) || HALLUCINATION_PATTERNS.some((p) => p.test(t));
}

/** Do the last tokens of `text` (normalized) spell out `phrase`? */
export function endsWithPhrase(text: string, phrase: string): boolean {
    const tokens = normalizeUtterance(text).split(' ').filter(Boolean);
    const phraseTokens = normalizeUtterance(phrase).split(' ').filter(Boolean);
    if (phraseTokens.length === 0 || phraseTokens.length > tokens.length) return false;
    const tail = tokens.slice(tokens.length - phraseTokens.length);
    return phraseTokens.every((w, i) => tail[i] === w);
}

/**
 * Remove the trailing phrase (plus surrounding filler/punctuation) from the raw
 * text, preserving the message's own casing and punctuation. Walks raw tokens
 * from the end so "…, send it please" strips cleanly.
 */
export function stripTailPhrase(text: string, phrase: string): string {
    const rawTokens = text.split(/\s+/).filter(Boolean);
    const phraseTokens = normalizeUtterance(phrase).split(' ').filter(Boolean);
    const isFiller = (token: string) => normalizeUtterance(token) === '';

    let i = rawTokens.length;
    const skipFiller = () => { while (i > 0 && isFiller(rawTokens[i - 1]!)) i--; };

    skipFiller();
    for (let k = phraseTokens.length - 1; k >= 0; k--) {
        skipFiller();
        if (i > 0 && normalizeUtterance(rawTokens[i - 1]!) === phraseTokens[k]) i--;
        else return text; // detection/strip mismatch — leave the text untouched
    }
    skipFiller();

    return rawTokens.slice(0, i).join(' ').replace(/[\s,;:]+$/, '').trim();
}

export type TurnAction =
    | { type: 'none' }
    | { type: 'submit'; message: string }
    | { type: 'discard' }   // clear the transcript, keep listening (rephrase)
    | { type: 'cancel' };   // abandon the turn, stop listening

export class TurnTranscript {
    private parts = new Map<number, string>();
    private assembledThrough = -1;
    private assembled: string[] = [];

    /** Add a transcribed segment; returns the action implied by the new tail. */
    addSegment(seq: number, rawText: string): TurnAction {
        const text = isHallucination(rawText) ? '' : rawText.trim();
        this.parts.set(seq, text);

        let advanced = false;
        while (this.parts.has(this.assembledThrough + 1)) {
            this.assembledThrough++;
            const part = this.parts.get(this.assembledThrough)!;
            this.parts.delete(this.assembledThrough);
            if (part) this.assembled.push(part);
            advanced = true;
        }
        if (!advanced) return { type: 'none' };
        return this.checkTail();
    }

    get text(): string {
        return this.assembled.join(' ');
    }

    /** Tap-to-end: take whatever has been assembled, no phrase required. */
    finalize(): string {
        return this.text;
    }

    /**
     * Drop everything assembled so far but keep sequence bookkeeping, so
     * segments spoken after a "scratch that" continue to assemble in order.
     */
    clear(): void {
        this.assembled = [];
    }

    private checkTail(): TurnAction {
        const text = this.text;
        if (!text) return { type: 'none' };
        for (const phrase of CANCEL_PHRASES) {
            if (endsWithPhrase(text, phrase)) return { type: 'cancel' };
        }
        for (const phrase of DISCARD_PHRASES) {
            if (endsWithPhrase(text, phrase)) return { type: 'discard' };
        }
        for (const phrase of END_PHRASES) {
            if (endsWithPhrase(text, phrase)) {
                return { type: 'submit', message: stripTailPhrase(text, phrase) };
            }
        }
        return { type: 'none' };
    }
}
