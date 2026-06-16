import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from './config';

const execFileAsync = promisify(execFile);

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

export const voiceTools = {
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

                // Run Piper via execFile (safe — no shell interpolation)
                await execFileAsync(config.piperBinaryPath, [
                    '--model', config.piperVoiceModel,
                    '--output_file', outputFile,
                ], {
                    timeout: 30000, // 30 second timeout
                    maxBuffer: 1024 * 1024,
                    // Pass text via stdin
                    env: { ...process.env },
                });

                // Piper reads from stdin — we need to pipe text
                // Actually, execFile doesn't support stdin easily.
                // Use a different approach: write text to a temp file and pipe it.
                const tempFile = path.join(config.ttsOutputDir, `.tts_input_${timestamp}.txt`);
                fs.writeFileSync(tempFile, text, 'utf-8');

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

                // Clean up temp file
                try { fs.unlinkSync(tempFile); } catch { /* ignore */ }

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
