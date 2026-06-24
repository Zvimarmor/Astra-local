#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Astra — local voice-note transcription for OpenClaw
#
# OpenClaw's `audio.transcription.command` calls this with the inbound media
# path and an output base. We convert WHATEVER audio OpenClaw hands us (Telegram
# voice notes are Opus-in-OGG, which whisper-cli can't read directly) to 16 kHz
# mono WAV via ffmpeg, then transcribe locally with whisper-cli. Fully offline.
#
# Usage (configured in ~/.openclaw/openclaw.json):
#   transcribe-voice.sh <media_path> <output_base>
# Produces: <output_base>.txt   (what OpenClaw reads back)
#
# Env:
#   WHISPER_CPP_MODEL  path to a ggml whisper model
#                      (default: ~/whisper-models/ggml-base.en.bin)
# ─────────────────────────────────────────────────────────────────────────────
set -eu

MEDIA="${1:?media path required}"
OUTBASE="${2:?output base required}"
MODEL="${WHISPER_CPP_MODEL:-$HOME/whisper-models/ggml-base.en.bin}"
LANG="${ASTRA_STT_LANG:-en}"

command -v ffmpeg     >/dev/null 2>&1 || { echo "ffmpeg not found" >&2; exit 127; }
command -v whisper-cli >/dev/null 2>&1 || { echo "whisper-cli not found" >&2; exit 127; }
[ -f "$MODEL" ] || { echo "whisper model not found: $MODEL" >&2; exit 1; }

WAV="$(mktemp -t astra-stt-XXXXXX).wav"
trap 'rm -f "$WAV"' EXIT INT TERM

# Normalize any input format → 16 kHz mono WAV (what whisper.cpp wants)
ffmpeg -y -loglevel error -i "$MEDIA" -ar 16000 -ac 1 -f wav "$WAV"

# Transcribe → writes "$OUTBASE.txt"; -np quiet, -nt no timestamps
whisper-cli -m "$MODEL" -f "$WAV" -otxt -of "$OUTBASE" -np -nt -l "$LANG"
