# Voice In / Voice Out Skill

Astra can listen to voice messages and answer out loud. Incoming WhatsApp voice
notes are transcribed **before** you see them — you just receive the text. To
answer *with voice*, call the `speak` helper.

Transcription runs in the gateway's audio-understanding stage, which shells out
to `dist/transcribe-cli.js` in the Astra repo (Gemini, verbatim prompt, with a
silence preflight and a model fallback). Plain text messages never touch it.

## When a voice note could not be transcribed
If the transcript you receive begins with `[VOICE_NOTE_FAILED]`, the recording
was silent, unintelligible, or transcription errored out. It is **not** something
the user said.

1. Reply with the exact Hebrew line given in that block, and nothing else.
2. Do **not** call any tool — there is no user intent to act on. In particular do
   not create tasks, events, or expenses, and do not call `speak`.
3. Do not guess what they might have meant, and do not mention this mechanism.

## Voice output modes
The output mode is stored and controlled by the user (default: `whatsapp`):
- **speakers** — the reply plays aloud on the Mac Mini speakers.
- **whatsapp** — the reply is sent back as a WhatsApp voice message.
- **off** — no voice; text only.

## When to speak the reply
Call `assistant_utils(action="speak", text="<your answer>")` when:
1. The user's message **came in as a voice message** (you'll typically see it
   echoed as a transcript). Answer in text **and** call `speak` so they get a
   spoken reply in their chosen mode.
2. The user explicitly asks you to **"say it", "talk to me", "read it out", "tell
   me out loud"**, or similar.

Keep spoken text concise (it is read aloud) and under ~1200 characters. Hebrew
and English are both supported automatically (Hebrew uses the Carmit voice).
If `speak` returns `mode: "off"`, just reply in text.

## Changing the mode
- "Speakers mode" / "talk through the speakers" / "play it out loud here"
  → `assistant_utils(action="set_voice_mode", mode="speakers")`
- "Reply with voice messages" / "send me voice notes" / "voice message mode"
  → `assistant_utils(action="set_voice_mode", mode="whatsapp")`
- "Stop talking" / "text only" / "turn off voice"
  → `assistant_utils(action="set_voice_mode", mode="off")`
- "Which voice mode am I in?" → `assistant_utils(action="get_voice_mode")`

## Rules
1. Never claim you spoke a reply unless the `speak` tool returned `spoken: true`.
2. Always also send the normal text reply — `speak` is in addition to text, not a
   replacement, so the conversation stays readable.
3. Don't call `speak` for every text message — only for voice-in or explicit
   spoken-output requests, to avoid spamming voice notes.

## Examples
- (voice note transcribed) "What's on my calendar today?" → answer in text, then
  `assistant_utils(action="speak", text="You have two events today: ...")`
- "Talk to me — what's the weather?" → `assistant_utils(action="speak", text="...")`
- "Switch to speakers mode" → `assistant_utils(action="set_voice_mode", mode="speakers")`
- "Stop sending voice messages" → `assistant_utils(action="set_voice_mode", mode="off")`

## Legacy
`assistant_utils(action="text_to_speech", text)` still exists: it generates a WAV
file with Piper (English) and returns the path without playing it. Prefer `speak`
for spoken replies; use `text_to_speech` only if a raw English WAV file is needed.
