/**
 * Voice-note transcription + validation.
 *
 * This is the "did we actually hear anything?" layer that sits between a raw
 * WhatsApp voice note and Astra's normal intent/tool flow. It is deliberately
 * split from the thing that *invokes* it (`tools/transcribe-cli.ts`) so the
 * validation rules can be unit-driven and reused.
 *
 * Where this runs in the pipeline
 * -------------------------------
 * Astra does not own the WhatsApp receive path — the OpenClaw gateway does.
 * OpenClaw's media-understanding stage (`tools.media.audio`) already does the
 * interception the hard way: it only fires for attachments carrying audio, so
 * plain text messages never touch this file and pay zero latency. What it does
 * NOT do is validate the transcript, so a silent or noise-only note otherwise
 * reaches the model as an empty/garbage instruction and the agent improvises.
 *
 * So we register this module as a `type: "cli"` audio model. OpenClaw hands us
 * a file path; stdout becomes `{{Transcript}}` for the turn.
 *
 * Three outcomes, and they are all *quiet* by design:
 *   ok             → the verbatim transcript, fed into the normal flow
 *   unintelligible → silence / noise / sub-2-character gibberish
 *   error          → the API threw, timed out, or the file is unreadable
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { config } from './config';
import { generateFromAudio } from './gemini';

/** Verbatim-transcription instruction. Kept exact: the sentinel is parsed below. */
export const TRANSCRIPTION_PROMPT =
    'You are a verbatim speech-to-text transcriber for Hebrew and English. ' +
    'Transcribe the spoken words accurately without any added conversational filler, ' +
    'explanations, or quotes. If the audio is pure silence, inaudible, or completely ' +
    "noise, reply ONLY with the exact string: '[INAUDIBLE]'.";

/** Sentinel the prompt asks for when there is nothing to transcribe. */
const INAUDIBLE_SENTINEL = '[INAUDIBLE]';

/** User-facing reply when transcription broke technically (API error, timeout, bad file). */
export const VOICE_REPLY_TECHNICAL_ERROR =
    '⚠️ הייתה בעיה טכנית בעיבוד ההודעה הקולית. אפשר לנסות להקליט שוב או לכתוב לי כטקסט.';

/** User-facing reply when the audio was fine but carried no intelligible speech. */
export const VOICE_REPLY_UNINTELLIGIBLE =
    '🎙️ לא הצלחתי לשמוע את ההודעה מספיק ברור (נשמע כשקט או רעש רקע). תוכל להקליט שוב בבקשה?';

/**
 * Under this, the file is a truncated/failed download rather than a recording.
 * Mirrors the 1024-byte floor OpenClaw applies before it even calls a model.
 */
const MIN_AUDIO_BYTES = 1024;

/** Inline base64 ceiling. Gemini's inline limit is ~20MB of request body. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** A transcript needs at least this many letters/digits to count as speech. */
const MIN_MEANINGFUL_CHARS = 2;

/** Transcription is short by nature; capping keeps a runaway model cheap. */
const MAX_OUTPUT_TOKENS = 2048;

export type TranscriptionResult =
    | { status: 'ok'; text: string }
    | { status: 'unintelligible'; reason: string }
    | { status: 'error'; error: string };

/**
 * Extension → MIME for the formats a chat channel actually delivers.
 * WhatsApp voice notes (PTT) are always OGG/Opus; forwarded "audio" messages
 * can be anything the sender's phone produced.
 */
const EXT_MIME: Record<string, string> = {
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mp3',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.amr': 'audio/amr',
    '.aiff': 'audio/aiff',
};

/**
 * Gemini rejects a MIME with codec parameters — WhatsApp reports voice notes as
 * `audio/ogg; codecs=opus`, which must be sent as bare `audio/ogg`.
 */
export function normalizeAudioMime(mime: string | undefined, filePath: string): string {
    const bare = (mime || '').split(';')[0].trim().toLowerCase();
    if (bare.startsWith('audio/')) return bare;
    return EXT_MIME[path.extname(filePath).toLowerCase()] || 'audio/ogg';
}

/** Letters and digits only — punctuation and emoji don't make a transcript real. */
function meaningfulCharCount(text: string): number {
    return text.replace(/[^\p{L}\p{N}]/gu, '').length;
}

/**
 * Strip the wrapping the model adds when it ignores "without quotes" — a single
 * pair of matched quotes around the whole string, nothing deeper.
 */
function stripWrappingQuotes(text: string): string {
    const m = text.match(/^["'“”„«»]([\s\S]*)["'“”„«»]$/);
    return m ? m[1].trim() : text;
}

/**
 * Apply the post-processing rules to raw model output.
 * Exported so the rules can be exercised without burning an API call.
 */
export function validateTranscript(raw: string): TranscriptionResult {
    const text = stripWrappingQuotes((raw || '').trim());

    if (!text) {
        return { status: 'unintelligible', reason: 'model returned empty output' };
    }
    // Case-insensitive substring, not equality: the model sometimes emits the
    // sentinel with trailing commentary despite the "reply ONLY" instruction.
    if (text.toUpperCase().includes(INAUDIBLE_SENTINEL)) {
        return { status: 'unintelligible', reason: 'model reported [INAUDIBLE]' };
    }
    const meaningful = meaningfulCharCount(text);
    if (meaningful < MIN_MEANINGFUL_CHARS) {
        return {
            status: 'unintelligible',
            reason: `only ${meaningful} meaningful character(s)`,
        };
    }
    return { status: 'ok', text };
}

/**
 * Transcribe an audio buffer. Never throws — every failure path is folded into
 * the returned discriminated union so callers can route without a try/catch.
 */
export async function transcribeAudioBuffer(
    audio: Buffer,
    mimeType: string,
    opts: { model?: string; timeoutMs?: number } = {}
): Promise<TranscriptionResult> {
    if (audio.length < MIN_AUDIO_BYTES) {
        // Too small to be a recording — but it's an empty/corrupt capture, not
        // a broken API, so the user should hear "say that again", not "I broke".
        return {
            status: 'unintelligible',
            reason: `audio is ${audio.length} bytes (< ${MIN_AUDIO_BYTES})`,
        };
    }
    if (audio.length > MAX_AUDIO_BYTES) {
        return {
            status: 'error',
            error: `audio is ${Math.round(audio.length / 1024 / 1024)}MB — over the ${MAX_AUDIO_BYTES / 1024 / 1024}MB inline limit`,
        };
    }

    // Tier 2: model fallback. `gemini.ts` already retries a single model through
    // transient 429/500/503s; this survives the case where that whole chain is
    // exhausted — which matters here because the configured primary
    // (`gemini-flash-latest`) is both 503-prone and capped at 20 requests/day on
    // the free tier, while `gemini-flash-lite-latest` is a separate, roomier
    // quota bucket. A voice note that can't be heard is a dead end for the user,
    // so it's worth a second provider hop that a background job wouldn't get.
    const chain = opts.model ? [opts.model] : transcriptionModelChain();
    const failures: string[] = [];

    for (const model of chain) {
        try {
            const raw = await generateFromAudio(TRANSCRIPTION_PROMPT, audio, mimeType, {
                // Verbatim transcription — sampling only invents words.
                temperature: 0,
                maxOutputTokens: MAX_OUTPUT_TOKENS,
                model,
                ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
            });
            return validateTranscript(raw);
        } catch (err: any) {
            const message = err?.message || String(err);
            failures.push(`${model}: ${message}`);
            console.error(`[Voice Note] ${model} failed — ${message}`);
        }
    }

    return { status: 'error', error: failures.join(' | ') };
}

/** Primary transcription model, then a distinct-quota fallback. De-duplicated. */
function transcriptionModelChain(): string[] {
    const fallback = (process.env.GEMINI_TRANSCRIBE_FALLBACK_MODEL || 'gemini-flash-lite-latest').trim();
    const primary = (process.env.GEMINI_TRANSCRIBE_MODEL || config.gemini.model).trim();
    return [...new Set([primary, fallback].filter(Boolean))];
}

/**
 * Peak level (dBFS) below which a recording carries no speech.
 *
 * Measured on this box: real speech peaks at −0.2 dB, digital silence reports
 * −91 dB, and noise faint enough to be unintelligible peaks around −55 dB.
 * −45 dB sits in the empty middle of that gap.
 */
const SILENCE_MAX_DB = -45;

const FFMPEG_TIMEOUT_MS = 15000;

/**
 * ffmpeg lookup path.
 *
 * OpenClaw spawns this CLI from its launchd-managed gateway, whose inherited
 * PATH is the minimal `/usr/bin:/bin` — which does NOT contain Homebrew's
 * /opt/homebrew/bin. Verified 2026-08-17: without this, `execFile('ffmpeg')`
 * ENOENTs, the preflight fails open, and a silent note reaches the model and
 * gets hallucinated into a real-looking instruction. Same class of bug as the
 * `node`-not-on-PATH failure documented in `whatsapp-send.ts`.
 */
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFMPEG_PATH = [
    path.dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH || '',
].filter(Boolean).join(path.delimiter);

/**
 * Deterministic silence preflight.
 *
 * Verified 2026-08-17: asked to transcribe four seconds of pure digital
 * silence, the model did NOT emit the `[INAUDIBLE]` sentinel it was told to —
 * it confidently hallucinated the Hebrew phrase "חבל על הזמן". A hallucination
 * is well-formed text, so no amount of output validation can catch it; the only
 * reliable defence is to never send silent audio to the model at all.
 *
 * Fails open: if ffmpeg is missing or its output can't be parsed we return
 * false and let the model try, because a false "I couldn't hear you" on a
 * perfectly good recording is worse than an occasional wasted call.
 */
function measurePeakDb(filePath: string): Promise<number | undefined> {
    return new Promise((resolve) => {
        execFile(
            FFMPEG_BIN,
            ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
            { timeout: FFMPEG_TIMEOUT_MS, env: { ...process.env, PATH: FFMPEG_PATH } },
            (err, _stdout, stderr) => {
                if (err && !stderr) {
                    console.error(`[Voice Note] silence preflight unavailable: ${err.message}`);
                    return resolve(undefined);
                }
                // volumedetect reports on stderr, e.g. "max_volume: -91.0 dB".
                const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr || '');
                resolve(m ? parseFloat(m[1]) : undefined);
            }
        );
    });
}

async function readAndTranscribe(
    filePath: string,
    opts: { mimeType?: string; model?: string; timeoutMs?: number }
): Promise<TranscriptionResult> {
    const peakDb = await measurePeakDb(filePath);
    if (peakDb !== undefined && peakDb < SILENCE_MAX_DB) {
        return {
            status: 'unintelligible',
            reason: `peak level ${peakDb} dBFS is below the ${SILENCE_MAX_DB} dBFS speech floor`,
        };
    }

    let audio: Buffer;
    try {
        audio = fs.readFileSync(filePath);
    } catch (err: any) {
        return { status: 'error', error: `cannot read ${filePath}: ${err?.message || err}` };
    }
    return transcribeAudioBuffer(audio, normalizeAudioMime(opts.mimeType, filePath), opts);
}

/** File-path convenience wrapper. Read failures are technical errors. */
export async function transcribeAudioFile(
    filePath: string,
    opts: { mimeType?: string; model?: string; timeoutMs?: number } = {}
): Promise<TranscriptionResult> {
    const result = await readAndTranscribe(filePath, opts);

    // Log to stderr, never stdout: when this runs as OpenClaw's CLI transcriber,
    // stdout IS the transcript and anything else on it corrupts the turn.
    if (result.status === 'ok') {
        console.error(`[Voice Note Transcribed]: "${result.text}"`);
    } else if (result.status === 'unintelligible') {
        console.error(`[Voice Note Unintelligible]: ${result.reason}`);
    } else {
        console.error(`[Voice Note Error]: ${result.error}`);
    }

    return result;
}
