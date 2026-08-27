#!/usr/bin/env node
/**
 * OpenClaw audio-understanding CLI adapter.
 *
 * Registered in ~/.openclaw/openclaw.json as:
 *
 *   tools.media.audio.models = [{
 *     type: "cli",
 *     command: "node",
 *     args: ["<repo>/dist/transcribe-cli.js", "{{MediaPath}}"],
 *     capabilities: ["audio"]
 *   }]
 *
 * Contract (from OpenClaw's `runCliEntry`):
 *   - argv[2] is the audio file path OpenClaw extracted from the message.
 *   - **stdout is the transcript.** It becomes `{{Transcript}}` for the turn and,
 *     with `echoTranscript: true`, is echoed to the chat before the agent runs.
 *   - Empty stdout or a non-zero exit = "this model failed", and OpenClaw falls
 *     through to the next entry / continues with the un-transcribed audio. That
 *     is exactly the silent-improvisation case we're here to prevent, so this
 *     process **always exits 0 and always prints something**.
 *   - Everything diagnostic goes to stderr.
 *
 * On the "terminate the flow" requirement: OpenClaw exposes no abort hook here —
 * the reply pipeline always continues after media understanding. The closest
 * faithful behaviour is to hand the agent a transcript that is an explicit
 * do-not-act directive carrying the exact user-facing sentence, so the failure
 * text reaches the user verbatim and no tool call is made on garbage input.
 */

// stdout is the transcript channel, and importing config.ts prints a banner to
// it (`[Config] Gemini: ...`), which would corrupt the very first line. Redirect
// console.log to stderr BEFORE anything else loads, then pull the transcriber in
// with require() so the patch is provably in place first — a top-level import
// would be hoisted above it.
console.log = (...args: unknown[]) => console.error(...args);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const transcriber = require('./transcribe-audio') as typeof import('./transcribe-audio');

/**
 * Wraps a failure message so the agent relays it and stops, instead of guessing
 * an intent from a transcript that doesn't exist.
 */
function directive(userMessage: string): string {
    return [
        '[VOICE_NOTE_FAILED]',
        'The voice note could not be transcribed. Reply to the user with exactly the',
        'following line and nothing else. Do not call any tools. Do not add commentary.',
        '',
        userMessage,
    ].join('\n');
}

async function main(): Promise<void> {
    const mediaPath = process.argv[2];

    if (!mediaPath) {
        console.error('[transcribe-cli] usage: transcribe-cli.js <audio-file> [mime-type]');
        process.stdout.write(directive(transcriber.VOICE_REPLY_TECHNICAL_ERROR));
        return;
    }

    const result = await transcriber.transcribeAudioFile(mediaPath, {
        ...(process.argv[3] ? { mimeType: process.argv[3] } : {}),
    });

    if (result.status === 'ok') {
        process.stdout.write(result.text);
        return;
    }

    process.stdout.write(
        directive(
            result.status === 'unintelligible'
                ? transcriber.VOICE_REPLY_UNINTELLIGIBLE
                : transcriber.VOICE_REPLY_TECHNICAL_ERROR
        )
    );
}

// Even an unexpected throw must leave the user with a sentence, not silence.
main().catch((err: any) => {
    console.error('[transcribe-cli] unexpected failure:', err?.message || err);
    process.stdout.write(directive(transcriber.VOICE_REPLY_TECHNICAL_ERROR));
});
