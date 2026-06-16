# Voice Skill — Piper TTS (Local Text-to-Speech)

## When to Activate
- User says: "read this", "say this", "voice", "speak", "audio"
- User asks: "read my tasks out loud", "voice summary"

## Tools Available
- `text_to_speech(text)` — Convert text to speech using Piper TTS. Returns a file path to the generated .wav audio file.

## How It Works
- Piper runs entirely locally — no internet, no API calls, no cloud.
- Audio is generated as WAV files in `data/media/tts/`.
- English is the primary language (best quality).
- Maximum text length: 500 characters.
- Old audio files are automatically cleaned up (keeps last 50).

## Rules
1. When the user asks you to "read" or "say" something, first generate the response text, then call `text_to_speech()` with that text.
2. Keep text concise and natural-sounding — avoid bullet points, symbols, or formatting in the TTS text.
3. If the text is too long, summarize it to fit within 500 characters.
4. If Piper is not installed, inform the user and provide the install command: `brew install piper`.
5. Always report the generated file path so the user can play it.

## Response Format
```
🔊 Generated audio response.
File: tts_1718565432.wav (12 KB)
▶️ Play with: afplay data/media/tts/tts_1718565432.wav
```

## Examples
- "Read my tasks" → First call `list_tasks()`, format the result as natural text, then call `text_to_speech("You have 3 pending tasks: ...")`.
- "Say hello" → `text_to_speech("Hello! How can I help you today?")`
