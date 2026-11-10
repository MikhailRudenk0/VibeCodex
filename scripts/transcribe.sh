#!/usr/bin/env bash
# Canonical local transcriber, shared by both Telegram instances.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -ne 1 ]; then
    echo 'Использование: scripts/transcribe.sh <аудиофайл>' >&2
    exit 2
fi
if [ ! -x "$ROOT/.voice-venv/bin/python" ]; then
    echo 'Не установлено окружение .voice-venv для локального распознавания.' >&2
    exit 2
fi
# exec makes timeout signals reach Python directly; no orphan whisper process.
exec "$ROOT/.voice-venv/bin/python" "$ROOT/scripts/transcribe.py" "$1"
