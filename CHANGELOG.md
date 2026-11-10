# Changelog

## 2026-11-10 — Local voice recognition repair

- Investigation found that the running bot used an old, ignored
  `bin/transcribe.sh` for whisper.cpp, despite an installed faster-whisper
  environment. That launcher suppressed decoder diagnostics. The Telegram
  handler also imposed the same 120-second processing deadline on every voice.
- `app/src/transcription.ts`, `app/src/bot.ts`: use the versioned launcher;
  allocate 60 seconds plus six times recording length, with a 120-second minimum
  and a 30-minute maximum. Report timeouts separately from decoder failures.
  Pass the Telegram duration; do not log recognized user speech.
- `scripts/transcribe.sh`, `scripts/transcribe.py`: local CPU int8 recognition,
  direct OGG/Opus decoding, offline model loading, clear missing-file/model and
  no-speech errors. The shell replaces itself with Python so timeout signals
  reach the decoder. The existing local Python entry point is now versioned.
- `test/transcription.ts`: duration budgets, literal subprocess arguments,
  nonzero exit/stderr, empty text, timeout, missing launcher and invalid limits.
- Long recognized replies are sent in plain-text chunks, preserving the local
  handler's existing behavior without Markdown parsing failures. README and
  `docs/VOICE_RECOGNITION.md` describe the actual local pipeline and limitations.
- Initial implementation completed at **2026-11-10T09:09:18+01:00**
  (Europe/Berlin; clock read after edits).
- Validation: **8 passed, 0 failed, 0 skipped**, 5.09 seconds in the live working
  tree; the same 8 tests passed in 2.40 seconds in an isolated staged tree.
  TypeScript passed in both trees; shell syntax and Python compilation passed.
  Existing unrelated local edits were kept outside this commit.
- Reproduced on a retained 137.0465-second OGG/Opus: the legacy launcher timed out
  at 120.31 seconds; the canonical launcher exited successfully in 124.68 seconds
  with 1684 text characters. No personal audio or transcript is committed.
  Short controls also passed: old 11-second FLAC 42.11 s, faster-whisper 31.78 s;
  old 44-second OGG/Opus 74.56 s. These are execution checks, not an error-rate
  benchmark for speech recognition.
- Deployment requires reloading the Telegram process; the current `projects`
  instance will be scheduled through deferred restart after the response.
- Final implementation and verification completed at
  **2026-11-10T09:16:33+01:00** (Europe/Berlin; environment clock, not commit time).

## 0.1.0 — 2025-02-08

Initial release.

- Telegram bot bridging to Claude Code via the Claude Agent SDK
- Full agent tools: Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch, Task
- Streaming responses with throttled edits and auto-splitting at 4096 char limit
- Session auto-resume from latest `.jsonl` — seamless laptop-to-phone handoff
- Project switching via `/switch` with inline keyboard picker
- Image support (photos forwarded as vision input)
- Single-user auth via Telegram user ID whitelist
- Works with Claude Pro/Max subscription or API key
