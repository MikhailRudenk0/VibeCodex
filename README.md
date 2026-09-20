<p align="center">
  <h1 align="center">VibeIDE</h1>
  <p align="center">
    <strong>Claude Code from your phone.</strong>
  </p>
  <p align="center">
    A Telegram bot that gives you the full Claude Code agent — read files, edit code, run commands — from anywhere.
  </p>
  <p align="center">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node >= 18">
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg" alt="macOS | Linux">
  </p>
</p>

---

You're on the couch. Your CI just broke. You pull out your phone, open Telegram:

```
You:    what's failing in the test suite?
Claude: Looking at the test output... The auth middleware test is
        failing because the mock doesn't include the new `role` field
        added in commit a3f2b1c. Let me fix it.
Claude: Fixed. The test now passes. I updated the mock in
        tests/auth.test.ts to include `role: "admin"`.
You:    run the tests again
Claude: All 47 tests passing.
```

That's VibeIDE. One script on your Mac, bridging Telegram to the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Same filesystem, same project context, full tool access.

It auto-resumes your latest Claude Code session — start a conversation in VS Code, pick it up on your phone, come back to your laptop and everything's there. One continuous workflow across devices.

Works from any Telegram client — phone, iPad, desktop, or [web](https://web.telegram.org).

## Quick Start

**1. Clone**

```bash
git clone https://github.com/junecv/vibeide.git
cd vibeide
npm install
```

**2. Create a Telegram bot**

Open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name. Copy the token.

**3. Configure**

```bash
cp .env.example .env
```

Edit `.env`:

```
TELEGRAM_BOT_TOKEN=7123456789:AAH...   # from BotFather
TELEGRAM_ALLOWED_USER_ID=123456789     # your Telegram user ID (message @userinfobot to get it)
```

If you're on Claude Pro/Max, that's it — the SDK uses your existing `claude login` session. If you're on API billing, also add `ANTHROPIC_API_KEY` to `.env`.

**4. Run**

```bash
npx tsx app/src/index.ts ~/Code/my-project
```

Send a message on Telegram. You're in.

## What You Can Do

VibeIDE gives you the **full Claude Code agent** over Telegram. Everything Claude Code can do in a terminal, you can do from your phone.

### Read & Understand Code

Ask questions about your codebase and Claude reads the actual files to answer.

```
You:    how does the auth middleware work?
Claude: Looking at src/middleware/auth.ts...
        It extracts the JWT from the Authorization header, verifies it
        against the secret in env, and attaches the decoded user to
        req.user. If verification fails, it returns 401.
```

### Edit Code

Claude writes directly to your filesystem. When you open your laptop, the changes are there.

```
You:    add input validation to the /signup endpoint
Claude: I'll add zod validation to the signup route. Reading the
        current handler... Done. I added a schema that validates
        email format and password length (min 8 chars), and returns
        400 with specific error messages on failure.
```

### Run Commands

Shell access to your machine — run tests, check git status, install packages, deploy.

```
You:    run the tests
Claude: Running `npm test`... 23/24 tests passing.
        One failure in payment.test.ts — the Stripe mock is
        returning the old API format. Want me to fix it?
```

### Send Images

Send screenshots, architecture diagrams, error messages, or UI mockups. Claude sees them.

```
You:    [photo of whiteboard sketch]
        implement this API design
Claude: I can see the REST endpoints you've sketched out. Let me
        create the routes...
```

### Switch Projects

Jump between projects without restarting. VibeIDE discovers all your Claude Code projects automatically.

```
/switch → [inline keyboard with your projects]
  > my-api (2m ago)
  > frontend (yesterday)
  > docs-site (3d ago)
```

### Seamless Laptop-to-Phone Handoff

VibeIDE auto-resumes your latest Claude Code session on startup. Start a conversation in VS Code or the terminal, walk away, and pick it up on Telegram — full context intact. Claude remembers every file it read, every edit it made, everything you discussed.

```
You:    what was the last thing we were working on?
Claude: We were adding input validation to the signup endpoint.
        I updated src/routes/auth.ts with a zod schema. Want me
        to continue with the login endpoint?
```

When you get back to your laptop, your IDE won't show the Telegram messages in its UI — but they're all saved in the session file. Just resume the session (e.g. `claude --resume` or hit Resume in VS Code) and Claude will have the full conversation, including everything from Telegram.

Start a fresh conversation anytime with `/new`.

## Features

- **Full Claude Code agent** — Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch, and Task (subagents)
- **Model switching** — `/model` to pick from available models (Fable, Opus, Sonnet, Haiku) mid-session
- **Effort control** — `/effort` to adjust reasoning depth (low → max), trades speed for quality
- **Streaming responses** — messages update live on Telegram as Claude thinks
- **Seamless handoff** — auto-resumes your latest Claude Code session, pick up on Telegram where you left off in VS Code
- **Project switching** — jump between any project in `~/.claude/projects/` without restarting
- **Image support** — send photos, screenshots, diagrams for Claude to analyze
- **Voice messages** — transcribes voice via whisper.cpp and forwards to Claude
- **Long response splitting** — auto-splits at ~3800 chars, well under Telegram's 4096 limit
- **Markdown rendering** — code blocks, bold, inline code, with plain-text fallback
- **Single user auth** — only your Telegram account can talk to the bot
- **Zero infrastructure** — single local process, no server, no database, no open ports
- **Any Telegram client** — works from phone, tablet, desktop app, or web browser

## Architecture

```
┌─────────────┐       ┌──────────────────────┐       ┌────────────────┐
│  Telegram    │◄─────►│  VibeIDE             │◄─────►│  Claude Agent   │
│  (any client)│       │  (Node.js, local)    │       │  SDK            │
└─────────────┘       └──────────────────────┘       └────────────────┘
                       Grammy bot (long polling)       @anthropic-ai/claude-agent-sdk
                       Auth: user ID whitelist         Tools: Read/Edit/Write/Bash/
                       Streams to Telegram               Glob/Grep/WebSearch/WebFetch/Task
                       Splits long messages            CWD = your project directory
                       Markdown + fallback             Session resume via session_id
```

Single process. ~300 lines of TypeScript. No moving parts.

## Commands

| Command     | What it does                                                   |
| ----------- | -------------------------------------------------------------- |
| `/model`    | Switch Claude model (Fable, Opus, Sonnet, Haiku) via picker    |
| `/effort`   | Set reasoning effort level (low / medium / high / xhigh / max) |
| `/projects` | List your recent Claude Code projects, sorted by last activity |
| `/switch`   | Change active project via inline keyboard picker               |
| `/new`      | Start a fresh conversation (same project, clears session)      |
| `/stop`     | Interrupt the currently running task                           |
| `/status`   | Show current project, session, model, and effort info          |
| `/file`     | Download a file from the server to Telegram                    |

Everything else you type — text or photos — is sent directly to Claude.

## How It Works

1. You send a message on Telegram (from any device)
2. Grammy bot receives it via long polling, checks your user ID
3. VibeIDE forwards it to the Claude Agent SDK via `query()` with your project as the working directory
4. Claude reads files, makes edits, runs commands — on your actual filesystem
5. Responses stream back to Telegram with throttled edits (~300ms) so you see it typing live
6. If a response exceeds ~3800 chars, it automatically splits into multiple messages
7. Session ID is saved — your next message continues the same conversation with full context

When you get back to your laptop, all file changes are already on disk. Open your editor and keep going.

## Project Structure

```
vibeide/
├── app/src/
│   ├── index.ts        # Entry point, CLI args, startup
│   ├── config.ts       # Env loading + validation
│   ├── bot.ts          # Grammy bot, auth, commands, photo handling
│   ├── bridge.ts       # Claude Agent SDK wrapper, session management
│   ├── streamer.ts     # Streaming responses → Telegram with throttling
│   └── projects.ts     # Project discovery from ~/.claude/projects/
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

## Configuration

| Variable                   | Where     | Required | Description                                                                 |
| -------------------------- | --------- | -------- | --------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | `.env`    | Yes | Bot token from [@BotFather](https://t.me/BotFather)                         |
| `TELEGRAM_ALLOWED_USER_ID` | `.env`    | Yes | Your numeric Telegram ID (message [@userinfobot](https://t.me/userinfobot)) |
| `ANTHROPIC_API_KEY`        | `.env`    | No  | Only needed for API billing. If you're on Claude Pro/Max, the SDK uses your existing `claude login` session automatically. |

The project path is passed as a CLI argument. If omitted, VibeIDE uses the current working directory.

## Security

VibeIDE runs with `bypassPermissions` — Claude can read, write, and execute anything in your project. This is safe because:

- **Only you can use it**: Every incoming message is checked against your Telegram user ID. Unauthorized users are silently ignored — no error, no response, nothing.
- **It's your machine**: The bot runs as a local process on your Mac/Linux box, operating on your own files.
- **No inbound network**: Grammy uses long polling (outbound HTTPS only). No ports opened, no webhook endpoints, no attack surface.
- **No data storage**: No database, no logs, no telemetry. Messages flow Telegram → Claude → Telegram and nowhere else.

This is the same trust model as running Claude Code in your terminal — because it _is_ Claude Code, just with Telegram as the interface.

## Requirements

- Node.js >= 18
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) >= 0.3.x (installed automatically via `npm install`)
- Claude Code installed and logged in (`claude login`), or an [Anthropic API key](https://console.anthropic.com/)
- A Telegram account + bot token from [@BotFather](https://t.me/BotFather)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome.

## License

[MIT](LICENSE)
