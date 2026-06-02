# Voice Skill (Deferred — Phase 2)

## Status
🚧 Voice support is planned for a later phase.

## Planned Implementation
- **TTS Engine**: Piper (local, offline)
- **Language**: English (primary)
- **Voice Model**: `en-us-amy-medium` (Piper)
- **Trigger Keywords**: "read this", "say this", "voice"

## When Ready
1. Install Piper on the Mac Mini (see `docs/MAC_MINI_SETUP_GUIDE.md`)
2. Download the English voice model
3. Implement the tool that pipes text through Piper and returns audio
4. Register the tool in the OpenClaw tool registry

## Notes
- Hebrew TTS via Piper has limited quality; English is recommended.
- The AWS version used Google Cloud TTS (he-IL-Wavenet-A) for high-quality Hebrew.
- Consider keeping Google Cloud TTS as a fallback for Hebrew if needed.
