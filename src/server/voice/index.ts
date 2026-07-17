/**
 * Voice service: speech-to-text and text-to-speech.
 *
 * Authenticated → proxy to the Pipali Platform audio routes (centralized
 * billing). Anon/local-key mode → call a locally-configured OpenAI-compatible
 * provider directly. The director/actor loop is untouched; this is a transport
 * layer for the client voice companion.
 */

import OpenAI from 'openai';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { AiModelApi, ChatModel } from '../db/schema';
import { isAuthenticated, getPlatformUrl } from '../auth';
import { platformFetch, withTokenRefresh } from '../http/platform-fetch';
import { getClientHeaders } from '../http/client-info';
import { sendMessageToFastModel } from '../processor/conversation';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'voice' });

export const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_TTS_VOICE = 'alloy';

type SpeechFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
export const SPEECH_FORMAT_CONTENT_TYPES: Record<SpeechFormat, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
};

/** Thrown when voice is requested in local mode but no OpenAI provider is configured. */
export class VoiceUnavailableError extends Error {
    constructor(message = 'No OpenAI-compatible provider is configured for voice') {
        super(message);
        this.name = 'VoiceUnavailableError';
    }
}

/**
 * Resolve a locally-configured OpenAI-compatible provider for anon mode.
 * Picks a provider backing an `openai` chat model, excluding the Pipali platform proxy.
 */
async function getLocalOpenAi(): Promise<OpenAI> {
    const [row] = await db
        .select({ apiKey: AiModelApi.apiKey, apiBaseUrl: AiModelApi.apiBaseUrl })
        .from(ChatModel)
        .innerJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id))
        .where(and(eq(ChatModel.modelType, 'openai'), ne(AiModelApi.name, 'Pipali')))
        .limit(1);

    if (!row?.apiKey) throw new VoiceUnavailableError();
    return new OpenAI({ apiKey: row.apiKey, baseURL: row.apiBaseUrl || 'https://api.openai.com/v1' });
}

function toArrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return out;
}

export interface TranscribeResult {
    text: string;
    model: string;
}

export async function transcribeAudio(params: {
    file: File;
    model?: string;
    language?: string;
    /** Vocabulary-bias prompt (e.g. "Pipali" + command phrases) for reliable proper-noun transcription. */
    prompt?: string;
}): Promise<TranscribeResult> {
    const model = params.model || DEFAULT_STT_MODEL;

    if (await isAuthenticated()) {
        const form = new FormData();
        form.append('file', params.file);
        form.append('model', model);
        if (params.language) form.append('language', params.language);
        if (params.prompt) form.append('prompt', params.prompt);
        const result = await platformFetch<{ text: string; model: string }>(
            `${getPlatformUrl()}/voice/transcribe`,
            { method: 'POST', body: form },
        );
        return { text: result.data.text ?? '', model: result.data.model ?? model };
    }

    const client = await getLocalOpenAi();
    const transcription = await client.audio.transcriptions.create({
        file: params.file,
        model,
        ...(params.language ? { language: params.language } : {}),
        ...(params.prompt ? { prompt: params.prompt } : {}),
        response_format: 'json',
    });
    log.info({ model, chars: transcription.text?.length ?? 0 }, 'Transcribed audio (local)');
    return { text: transcription.text ?? '', model };
}

export interface SpeechResult {
    audio: Uint8Array<ArrayBuffer>;
    contentType: string;
    model: string;
}

export async function synthesizeSpeech(params: {
    text: string;
    voice?: string;
    model?: string;
    format?: string;
}): Promise<SpeechResult> {
    const model = params.model || DEFAULT_TTS_MODEL;
    const format: SpeechFormat = params.format && params.format in SPEECH_FORMAT_CONTENT_TYPES
        ? (params.format as SpeechFormat)
        : 'mp3';
    const contentType = SPEECH_FORMAT_CONTENT_TYPES[format]!;

    if (await isAuthenticated()) {
        // platformFetch JSON-parses, so use withTokenRefresh + raw fetch for binary audio.
        const bytes = await withTokenRefresh(async (token) => {
            const res = await fetch(`${getPlatformUrl()}/voice/speech`, {
                method: 'POST',
                headers: {
                    ...getClientHeaders(),
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ text: params.text, voice: params.voice, model, format }),
            });
            if (!res.ok) {
                const errText = await res.text();
                const err = new Error(`Platform speech error: ${res.status} - ${errText}`) as Error & { status?: number };
                err.status = res.status;
                throw err;
            }
            return new Uint8Array(await res.arrayBuffer());
        });
        return { audio: toArrayBufferBacked(bytes), contentType, model };
    }

    const client = await getLocalOpenAi();
    const response = await client.audio.speech.create({
        model,
        voice: params.voice || DEFAULT_TTS_VOICE,
        input: params.text,
        response_format: format,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    log.info({ model, chars: params.text.length, bytes: bytes.length }, 'Synthesized speech (local)');
    return { audio: toArrayBufferBacked(bytes), contentType, model };
}

// Prompt to rephrase written text into a natural, spoken style.
const NATURAL_SPEECH_PROMPT = `You are Pipali's voice. Convert the written response below into how you would naturally say it aloud in a friendly conversation.
Keep it brief and easy to follow by ear: plain spoken sentences — no markdown, lists, code, or URLs.
Reply with only the spoken text.`;

// Prompt to describe an action awaiting user authorization. Faithfulness over
// polish: the user approves or declines based on this sentence alone.
const ACTION_SPEECH_PROMPT = `You are Pipali's voice. The text below is an action Pipali wants the user's permission to take — a file change or an external tool call.
In one or two short spoken sentences, say what the action actually does in substance. Be faithful: never downplay deletions, overwrites, or anything destructive.
Plain spoken language — no markdown, no code syntax; refer to files by name, never full paths. Reply with only the spoken text.`;

export type SpeechSummaryKind = 'response' | 'action';

/**
 * Summarize text into a natural spoken style using the fast model: 'response'
 * rephrases a final answer, 'action' describes a pending edit/command for a
 * confirmation readout. Throws on failure to let the client's prefetch chain
 * fall back to its mechanical summary (see useVoiceCompanion prefetch).
 */
export async function summarizeForSpeech(text: string, kind: SpeechSummaryKind = 'response'): Promise<{ summary: string }> {
    const result = await sendMessageToFastModel(text, kind === 'action' ? ACTION_SPEECH_PROMPT : NATURAL_SPEECH_PROMPT);

    const summary = (result?.message ?? '').trim();
    if (!summary) throw new Error('Voice summary came back empty');

    log.info({ kind, inputChars: text.length, summaryChars: summary.length }, 'Summarized for speech');
    return { summary };
}
