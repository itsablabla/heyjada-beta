/**
 * Deterministic voice intent parser for the voice companion.
 *
 * Runs before any LLM involvement. It maps a spoken utterance to a confirmation
 * decision, and recognizes a lightweight "go-ahead" ack. It branches on whether
 * the confirmation is a question (`ask_user`): for questions the spoken reply is
 * the answer (guidance), never an approve/decline.
 *
 * Pure module — no DOM, no I/O — so it's cheap to unit-test exhaustively.
 */

export type VoiceIntent =
    | { type: 'approve' }
    | { type: 'approve_dont_ask' }
    | { type: 'decline' }
    | { type: 'details' }
    | { type: 'repeat' }
    | { type: 'stop_listening' }
    | { type: 'guidance'; text: string };

// Single-token filler stripped before matching ("um, yes please" → "yes").
const FILLER = new Set(['um', 'uh', 'er', 'hmm', 'mm', 'like', 'just', 'please', 'well']);

const APPROVE = new Set([
    'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'continue', 'go', 'go ahead',
    'proceed', 'do it', 'confirm', 'confirmed', 'approve', 'approved', 'sounds good',
    'go for it', 'affirmative', 'yes go',
]);
const DECLINE = new Set([
    'no', 'nope', 'nah', 'cancel', 'stop', 'dont', 'do not', 'decline', 'reject',
    'abort', 'never mind', 'nevermind', 'negative',
]);
const DETAILS = new Set([
    'details', 'detail', 'explain', 'more', 'tell me more', 'what', 'what is it',
    'what does it do', 'show me', 'elaborate', 'tell me',
]);
const REPEAT = new Set(['repeat', 'say again', 'again', 'come again', 'what did you say', 'pardon']);
const STOP_LISTENING = [
    'stop listening', 'turn off voice', 'turn voice off', 'disable voice', 'stop voice',
    'exit voice', 'be quiet', 'mute',
];
// A go-ahead is a frictionless readiness ack — approve words plus "show me the details".
const GO_AHEAD_EXTRA = new Set(['ready', 'im ready', 'go on', 'lets hear it', 'lets go']);

/** Lowercase, strip punctuation/apostrophes, drop filler tokens, collapse spaces. */
export function normalizeUtterance(text: string): string {
    return text
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w && !FILLER.has(w))
        .join(' ')
        .trim();
}

function matchesStopListening(n: string): boolean {
    return STOP_LISTENING.some((p) => n === p || n.includes(p));
}

/**
 * Is this utterance a go-ahead — the user signaling they're ready to listen?
 * Permissive: any approve word, a details request, or a readiness phrase.
 */
export function parseGoAhead(text: string): boolean {
    const n = normalizeUtterance(text);
    if (!n) return false;
    return APPROVE.has(n) || DETAILS.has(n) || GO_AHEAD_EXTRA.has(n);
}

/**
 * Classify a spoken reply to a confirmation. `isQuestion` should be true for
 * `ask_user` operations, where the reply is a free-form answer (guidance).
 */
export function parseConfirmationIntent(text: string, opts: { isQuestion: boolean }): VoiceIntent {
    const n = normalizeUtterance(text);
    if (!n) return { type: 'guidance', text };

    // Universal commands, available even for questions.
    if (matchesStopListening(n)) return { type: 'stop_listening' };
    if (REPEAT.has(n)) return { type: 'repeat' };
    if (n.includes('dont ask again') || n === 'always' || n === 'yes always') {
        return { type: 'approve_dont_ask' };
    }

    // A question's reply is the answer, not an approve/decline.
    if (opts.isQuestion) return { type: 'guidance', text };

    if (APPROVE.has(n)) return { type: 'approve' };
    if (DECLINE.has(n)) return { type: 'decline' };
    if (DETAILS.has(n)) return { type: 'details' };

    return { type: 'guidance', text };
}
