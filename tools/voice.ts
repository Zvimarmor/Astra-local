import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { config } from './config';
import { getSetting, setSetting } from './storage';
import { sendWhatsAppMedia } from './whatsapp-send';
import { isSpotifyPlaying } from './spotify';

/**
 * Voice Tools — Piper TTS (Local Text-to-Speech)
 *
 * Generates audio from text using Piper, a fast local TTS engine.
 * Runs entirely offline — no API calls, no cloud.
 *
 * Safety:
 *   - Uses execFile (not exec) to prevent shell injection
 *   - Text length capped at 500 characters
 *   - Output limited to data/media/tts/ directory
 *   - Old files auto-cleaned (keeps last 50)
 */

const MAX_TEXT_LENGTH = 500;
const MAX_TTS_FILES = 50;

function cleanupOldTtsFiles(): void {
    try {
        const dir = config.ttsOutputDir;
        if (!fs.existsSync(dir)) return;

        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.wav'))
            .map(f => ({
                name: f,
                path: path.join(dir, f),
                mtime: fs.statSync(path.join(dir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime); // newest first

        // Remove files beyond the limit
        for (let i = MAX_TTS_FILES; i < files.length; i++) {
            fs.unlinkSync(files[i].path);
        }
    } catch (err: any) {
        console.error('[TTS] Cleanup error:', err.message);
    }
}

// ─── Voice output (spoken replies) ───────────────────────────────────────────
// Modes stored in the `settings` table under key `voice_mode`:
//   'speakers' → play the reply aloud through the Mac Mini speakers (afplay)
//   'whatsapp' → send the reply as a WhatsApp voice/audio message (default)
//   'off'      → no voice output (text only)
const MAX_SPEAK_LENGTH = 1200;
const VOICE_MODES = ['speakers', 'whatsapp', 'off'] as const;
type VoiceMode = (typeof VOICE_MODES)[number];

function getVoiceMode(): VoiceMode {
    let m = getSetting('voice_mode', 'whatsapp');
    if (m === 'telegram') m = 'whatsapp'; // legacy stored value → renamed mode
    return (VOICE_MODES as readonly string[]).includes(m) ? (m as VoiceMode) : 'whatsapp';
}

/** Run a binary with no shell (injection-safe). Resolves on exit 0. */
function run(cmd: string, args: string[], timeoutMs = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`)));
        proc.on('error', reject);
    });
}

/** Synthesize text to an AIFF file with macOS `say`. Hebrew → Carmit, else default. */
async function synthSay(text: string, outAiff: string): Promise<void> {
    const isHebrew = /[֐-׿]/.test(text);
    const args = isHebrew ? ['-v', 'Carmit', '-o', outAiff, text] : ['-o', outAiff, text];
    await run('say', args);
}

/** Send an OGG/Opus voice reply to the owner over WhatsApp (via OpenClaw gateway). */
async function sendWhatsAppVoice(oggPath: string): Promise<void> {
    const ok = await sendWhatsAppMedia(oggPath);
    if (!ok) throw new Error('WhatsApp voice send failed — check WHATSAPP_OWNER_TARGET and the gateway');
}

export const voiceTools = {
    set_voice_mode: {
        name: 'set_voice_mode',
        description: "Set how Astra speaks replies aloud: 'speakers' (play on the Mac Mini speakers), 'whatsapp' (send a WhatsApp voice message), or 'off' (text only). Use when the user says things like 'speakers mode', 'reply with voice messages', or 'stop talking'.",
        parameters: {
            type: 'object',
            properties: {
                mode: { type: 'string', enum: ['speakers', 'whatsapp', 'off'], description: 'Voice output mode' }
            },
            required: ['mode']
        },
        execute: async (args: any) => {
            const mode = String(args.mode || '').toLowerCase();
            if (!(VOICE_MODES as readonly string[]).includes(mode)) {
                return { status: 'error', error: `Invalid mode "${mode}". Use one of: speakers, whatsapp, off.` };
            }
            setSetting('voice_mode', mode);
            const desc = mode === 'speakers' ? 'play aloud on the Mac Mini speakers'
                : mode === 'whatsapp' ? 'reply with WhatsApp voice messages' : 'stay text-only';
            return { status: 'success', mode, message: `Voice mode set to "${mode}" — I will ${desc}.` };
        }
    },

    get_voice_mode: {
        name: 'get_voice_mode',
        description: 'Show the current voice output mode (speakers, whatsapp, or off).',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ status: 'success', mode: getVoiceMode() })
    },

    speak: {
        name: 'speak',
        description: "Speak a reply aloud using the current voice mode. If mode is 'speakers' it plays on the Mac Mini speakers; if 'whatsapp' it sends a WhatsApp voice message; if 'off' it does nothing. Call this with your answer text after the user sends a voice message or asks you to talk. Supports Hebrew and English.",
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'The text to speak aloud (max 1200 chars).' }
            },
            required: ['text']
        },
        execute: async (args: any) => {
            try {
                const text = (args.text || '').trim();
                if (!text) return { status: 'error', error: 'No text provided.' };
                if (text.length > MAX_SPEAK_LENGTH) {
                    return { status: 'error', error: `Text too long (${text.length} chars). Max ${MAX_SPEAK_LENGTH}.` };
                }

                const mode = getVoiceMode();
                if (mode === 'off') return { status: 'success', spoken: false, mode, message: 'Voice output is off.' };

                fs.mkdirSync(config.ttsOutputDir, { recursive: true });
                const stamp = Date.now();
                const aiff = path.join(config.ttsOutputDir, `say_${stamp}.aiff`);
                await synthSay(text, aiff);

                if (mode === 'speakers') {
                    // Don't fight Spotify for the speakers/CoreAudio device: if music is
                    // playing, afplay would both talk over it AND cause buffer-underrun
                    // stutter. Deliver this reply as a WhatsApp voice message instead.
                    if (await isSpotifyPlaying()) {
                        const ogg = path.join(config.ttsOutputDir, `say_${stamp}.ogg`);
                        await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', ogg]);
                        await sendWhatsAppVoice(ogg);
                        fs.unlinkSync(aiff);
                        fs.unlinkSync(ogg);
                        return { status: 'success', spoken: true, mode, message: 'Music is playing — sent the reply as a WhatsApp voice message instead of talking over the speakers.' };
                    }
                    await run('afplay', [aiff]);
                    fs.unlinkSync(aiff);
                    return { status: 'success', spoken: true, mode, message: 'Played on the Mac Mini speakers.' };
                }

                // whatsapp voice message
                const ogg = path.join(config.ttsOutputDir, `say_${stamp}.ogg`);
                await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', ogg]);
                await sendWhatsAppVoice(ogg);
                fs.unlinkSync(aiff);
                fs.unlinkSync(ogg);
                return { status: 'success', spoken: true, mode, message: 'Sent as a WhatsApp voice message.' };
            } catch (err: any) {
                console.error('[Voice] speak error:', err.message);
                return { status: 'error', error: err.message };
            }
        }
    },

    text_to_speech: {
        name: "text_to_speech",
        description: "Convert text to speech audio using the local Piper TTS engine. Returns the file path to the generated .wav audio file. Use this when the user asks you to 'read this', 'say this', or requests a voice response.",
        parameters: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "The text to convert to speech (max 500 characters, English recommended)"
                }
            },
            required: ["text"]
        },
        execute: async (args: any) => {
            try {
                const text = (args.text || '').trim();
                if (!text) {
                    return { status: "error", error: "No text provided." };
                }

                if (text.length > MAX_TEXT_LENGTH) {
                    return {
                        status: "error",
                        error: `Text too long (${text.length} chars). Maximum is ${MAX_TEXT_LENGTH} characters.`
                    };
                }

                // Verify Piper binary exists
                if (!fs.existsSync(config.piperBinaryPath)) {
                    return {
                        status: "error",
                        error: `Piper not found at ${config.piperBinaryPath}. Install with: brew install piper`
                    };
                }

                // Verify voice model exists
                if (!fs.existsSync(config.piperVoiceModel)) {
                    return {
                        status: "error",
                        error: `Voice model not found at ${config.piperVoiceModel}. See docs/MAC_MINI_SETUP_GUIDE.md for download instructions.`
                    };
                }

                // Ensure output directory exists
                fs.mkdirSync(config.ttsOutputDir, { recursive: true });

                // Generate unique filename
                const timestamp = Date.now();
                const outputFile = path.join(config.ttsOutputDir, `tts_${timestamp}.wav`);

                // Run Piper (safe — no shell interpolation)
                // Piper reads from stdin — we need to pipe text

                await new Promise<void>((resolve, reject) => {
                    const proc = require('child_process').spawn(config.piperBinaryPath, [
                        '--model', config.piperVoiceModel,
                        '--output_file', outputFile,
                    ], {
                        stdio: ['pipe', 'pipe', 'pipe'],
                        timeout: 30000,
                    });

                    proc.stdin.write(text);
                    proc.stdin.end();

                    let stderr = '';
                    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

                    proc.on('close', (code: number) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Piper exited with code ${code}: ${stderr}`));
                    });
                    proc.on('error', reject);
                });

                // Verify output was created
                if (!fs.existsSync(outputFile)) {
                    return { status: "error", error: "Piper did not generate output." };
                }

                const fileSize = fs.statSync(outputFile).size;

                // Cleanup old files
                cleanupOldTtsFiles();

                console.log(`[TTS] Generated: ${path.basename(outputFile)} (${Math.round(fileSize / 1024)} KB)`);

                return {
                    status: "success",
                    file_path: outputFile,
                    file_name: path.basename(outputFile),
                    size_kb: Math.round(fileSize / 1024),
                    message: `Audio generated: ${path.basename(outputFile)}`
                };
            } catch (err: any) {
                console.error("[TTS] Error:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
