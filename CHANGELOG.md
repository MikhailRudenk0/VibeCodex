# Changelog

## 2026-11-22T19:09:26+01:00 — Restore file delivery after returning to a project

- Reproduced the user's failure with a real installed app-server: a file
  upload works in project A, works in B, and fails on returning to the saved
  conversation in A before any Telegram request. A loaded thread retains
  its original MCP process and environment despite new thread/resume config.
- `app/src/codex/bridge.ts`: invalidate the old gateway and restart app-server
  before binding the next active turn when the thread, project, chat or topic
  changes. Resume the saved conversation without deleting history. Reuse the
  connection for consecutive turns in the same context. Keep stale-key,
  recipient, active-turn, cancellation and file-boundary checks intact.
- `test/file-delivery-switch.ts`: eight mocked uploads through public
  sendMessage and the actual private gateway, including returns to both
  projects, a fresh conversation, chat/topic changes and connection reuse.
  `test/file-mcp-switch-live.ts`: real app-server regression with one minimal
  model turn to persist a conversation; Telegram is mocked. Without that turn
  an unsaved conversation is replaced, which does not reproduce the defect.
- The existing local automatic-file-delivery implementation was not yet fully
  tracked. Include its required scope/gateway/MCP modules, configuration,
  host-tool RPC, bot integration and relevant tests so the fix is reproducible.
  These dependencies predate this task; their original edit times are unknown.
  Independent pending voice/download and text-recovery changes are excluded.
- `docs/FILE_DELIVERY.md`: routing contract, cause, correction, regression
  commands, model usage, and restart requirements. No credentials, live chat
  IDs, model transcripts or private files are committed.
- Working-tree checks passed: TypeScript, file-delivery-switch, file-delivery,
  file-gateway, dynamic-tool-protocol and config. The persisted-project probe
  changed from two mock uploads plus one rejection to three successful uploads,
  retaining the original conversation ID. Final isolated verification completed
  at **2026-11-22T19:10:55+01:00**: the same TypeScript and five offline scripts passed,
  and the real app-server regression again delivered three mock files while
  retaining the saved conversation. No real Telegram upload was attempted by
  these tests; actual screenshot delivery remains pending after restart.
- Status: code prepared; applying it requires a deferred restart of the current
  projects bot after the reply. Do not claim the user's PNGs delivered based on
  fake Telegram tests. Timestamp is the completion of the implementation and
  working-tree verification, read from the Europe/Berlin system clock.

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
