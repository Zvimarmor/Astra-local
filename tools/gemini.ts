/**
 * Gemini API client — Astra's cloud inference path.
 *
 * Replaces the local Ollama endpoint. Deliberately dependency-free: this uses
 * global `fetch` (Node 18+) rather than `@google/genai`, because the only
 * callers are a background photo tagger and the dashboard health panel. Adding
 * an SDK (and its transitive tree) to buy two REST calls isn't worth it.
 *
 * IMPORTANT — this is NOT the chat engine.
 * The conversational agent is driven by the OpenClaw gateway, which talks to
 * Gemini itself using its own `models.providers.google` config in
 * ~/.openclaw/openclaw.json. Nothing in this repo sits in the chat path.
 * This module exists for the repo-side services that used to call Ollama.
 *
 * API-version gotcha: Gemini's generateContent for the current model aliases
 * is served on **v1beta**, not v1. `gemini-flash-latest` returns 404 on v1.
 */

import { config } from './config';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Transient statuses worth a retry: rate limit + upstream overload. */
const RETRYABLE = new Set([429, 500, 503]);

export interface GeminiOptions {
    /** Override the configured model for this call. */
    model?: string;
    /** Cap output length. Keeps free-tier token spend predictable. */
    maxOutputTokens?: number;
    temperature?: number;
    /** Hard timeout per attempt, ms. */
    timeoutMs?: number;
    /** Attempts on a retryable status before giving up. */
    retries?: number;
}

interface GeminiPart {
    text?: string;
    inline_data?: { mime_type: string; data: string };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Low-level generateContent call. Returns the concatenated text of the first
 * candidate, or throws with the API's own error message (which is far more
 * useful than a bare status code — e.g. it names retired models explicitly).
 */
async function generateContent(parts: GeminiPart[], opts: GeminiOptions = {}): Promise<string> {
    if (!config.gemini.apiKey) {
        throw new Error('GEMINI_API_KEY is not configured (.env)');
    }

    const model = opts.model || config.gemini.model;
    const retries = opts.retries ?? 2;
    const timeoutMs = opts.timeoutMs ?? config.gemini.timeoutMs;

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            temperature: opts.temperature ?? 0.4,
            maxOutputTokens: opts.maxOutputTokens ?? 1024,
        },
    };

    let lastError = '';

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            // Exponential backoff. Free-tier 429s are per-minute, so this is
            // a best-effort nudge, not a guarantee — callers should tolerate
            // an eventual throw.
            await sleep(1000 * Math.pow(2, attempt - 1));
        }

        let res: Response;
        try {
            res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
                method: 'POST',
                headers: {
                    'x-goog-api-key': config.gemini.apiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e: any) {
            lastError = `network: ${e.message}`;
            continue;
        }

        const raw = await res.text();

        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            let emptyBody = false;
            try {
                const parsed = JSON.parse(raw);
                if (parsed?.error?.message) msg = `${res.status}: ${parsed.error.message}`;
            } catch {
                emptyBody = true;
                msg = `HTTP ${res.status} (empty body) for model '${model}'`;
            }
            lastError = msg;

            // Observed 2026-08-06: the API intermittently returns a 404 with an
            // EMPTY body for a model that works fine on the next attempt. A
            // genuine "model not found" always carries a JSON error message
            // (e.g. "no longer available to new users"), so an empty-bodied
            // 4xx is a transient blip and is worth retrying.
            if (RETRYABLE.has(res.status) || emptyBody) continue;
            throw new Error(`Gemini ${msg}`);
        }

        const data = JSON.parse(raw);
        const candidate = data?.candidates?.[0];

        if (!candidate) {
            // Usually a safety block — promptFeedback explains why.
            const reason = data?.promptFeedback?.blockReason || 'no candidates returned';
            throw new Error(`Gemini returned no output (${reason})`);
        }

        const text = (candidate.content?.parts || [])
            .map((p: GeminiPart) => p.text || '')
            .join('')
            .trim();

        if (!text && candidate.finishReason === 'MAX_TOKENS') {
            throw new Error('Gemini hit MAX_TOKENS before emitting text (raise maxOutputTokens)');
        }

        return text;
    }

    throw new Error(`Gemini failed after ${retries + 1} attempts — ${lastError}`);
}

/** Plain text prompt → text completion. */
export async function generateText(prompt: string, opts: GeminiOptions = {}): Promise<string> {
    return generateContent([{ text: prompt }], opts);
}

/**
 * Vision: describe/analyse an image. Replaces the local llava call.
 * `image` is raw bytes; they're base64-encoded inline (fine for the ~1MB
 * thumbnails Immich serves — for larger files the Files API would be needed).
 */
export async function generateFromImage(
    prompt: string,
    image: Buffer,
    mimeType: string = 'image/jpeg',
    opts: GeminiOptions = {}
): Promise<string> {
    return generateContent(
        [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: image.toString('base64') } },
        ],
        opts
    );
}

/**
 * Health probe for the dashboard. Cheap: lists models rather than generating,
 * so it costs no tokens and doesn't consume free-tier request quota for
 * generation.
 */
export async function geminiHealth(): Promise<{
    ok: boolean;
    model: string;
    modelAvailable?: boolean;
    error?: string;
}> {
    if (!config.gemini.apiKey) {
        return { ok: false, model: config.gemini.model, error: 'GEMINI_API_KEY not set' };
    }

    try {
        const res = await fetch(`${GEMINI_BASE}/models`, {
            headers: { 'x-goog-api-key': config.gemini.apiKey },
            signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
            return { ok: false, model: config.gemini.model, error: `HTTP ${res.status}` };
        }

        const data = await res.json() as any;
        const ids: string[] = (data.models || []).map((m: any) => String(m.name).replace('models/', ''));

        return {
            ok: true,
            model: config.gemini.model,
            modelAvailable: ids.includes(config.gemini.model),
        };
    } catch (e: any) {
        return { ok: false, model: config.gemini.model, error: e.message };
    }
}
