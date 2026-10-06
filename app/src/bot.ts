import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { exec } from "child_process";
import { createReadStream, existsSync } from "fs";
import { writeFile, unlink, stat } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Config } from "./config.js";
import { Bridge } from "./bridge.js";
import { CodexBridge } from "./codex/bridge.js";
import { formatRelativeTime, type ProjectInfo } from "./projects.js";

/**
 * What the Telegram layer needs from an agent backend. Both bridges satisfy it,
 * so every handler below is provider-agnostic.
 */
interface AgentBridge {
  projectPath: string;
  sessionId: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  listProjects(): Promise<ProjectInfo[]>;
  resumeLatestSession(): Promise<string | undefined>;
  clearSession(): void;
  saveState(): void;
  getSupportedModels(): Promise<{ value: string; displayName: string }[]>;
  /** Effort levels this backend accepts right now, in the order to show them. */
  getSupportedEfforts(): Promise<string[]>;
  setModel(model: string): Promise<boolean>;
  setEffort(effort: string): Promise<boolean>;
  stop(): Promise<boolean>;
  sendMessage(
    chatId: number,
    text: string,
    images?: { data: string; mediaType: string }[]
  ): Promise<void>;
}

interface EffortChoice { value: string; label: string; desc: string }

/**
 * Presentation for effort levels. Which ones are offered is decided by the
 * backend — Codex reports them per model and they differ between models — so
 * anything unknown still renders with its bare name rather than disappearing.
 */
const EFFORT_LABELS: Record<string, { label: string; desc: string }> = {
  minimal: { label: "⚪ Minimal", desc: "Almost no reasoning" },
  low:     { label: "🟢 Low",     desc: "Fast, lighter reasoning" },
  medium:  { label: "🟡 Medium",  desc: "Balanced" },
  high:    { label: "🟠 High",    desc: "Deep reasoning" },
  xhigh:   { label: "🔴 XHigh",   desc: "Extended, for hard tasks" },
  max:     { label: "⚫ Max",     desc: "Maximum effort" },
  ultra:   { label: "🟣 Ultra",   desc: "Beyond max, slowest" },
};

function describeEffort(value: string): EffortChoice {
  const known = EFFORT_LABELS[value];
  return { value, label: known?.label ?? value, desc: known?.desc ?? "" };
}

function transcribeAudio(audioPath: string): Promise<string> {
  // Resolve transcribe.sh relative to the project root (two levels up from app/src/)
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const script = join(projectRoot, "bin", "transcribe.sh");

  if (!existsSync(script)) {
    // bin/ is gitignored and carries platform-specific whisper builds, so a fresh
    // checkout has no transcriber. Say that plainly instead of leaking a shell error.
    return Promise.reject(
      new Error("распознавание голоса не установлено (нет bin/transcribe.sh)")
    );
  }

  return new Promise((resolve, reject) => {
    exec(
      `"${script}" "${audioPath}"`,
      { timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Transcription failed: ${stderr || err.message}`));
        } else {
          const text = stdout.trim();
          if (!text) {
            reject(new Error("Transcription returned empty result"));
          } else {
            resolve(text);
          }
        }
      }
    );
  });
}

export async function createBot(config: Config, initialProjectPath?: string): Promise<Bot> {
  const bot = new Bot(config.telegramBotToken);

  const bridge: AgentBridge =
    config.provider === "codex"
      ? new CodexBridge(bot.api, initialProjectPath, config.codex)
      : new Bridge(bot.api, initialProjectPath);

  /**
   * Backing lists for /switch keyboards, keyed by the message the buttons live
   * on. A single shared list would let one user's tap land on another user's
   * project, or an old message's button point at the wrong index.
   */
  const switchChoices = new Map<number, ProjectInfo[]>();

  // Restore saved state (survives OOM restarts), fall back to session discovery
  const saved =
    config.provider === "codex" ? await CodexBridge.loadState() : await Bridge.loadState();
  // Model and effort are preferences: they survive even when the saved project
  // is gone or the session was cleared with /new.
  if (saved?.model) bridge.model = saved.model;
  if (saved?.effort) bridge.effort = saved.effort;

  const projectUsable = saved ? existsSync(saved.projectPath) : false;
  if (saved && !projectUsable) {
    console.log(`Saved project ${saved.projectPath} no longer exists; keeping ${bridge.projectPath}`);
  } else if (saved) {
    bridge.projectPath = saved.projectPath;
    bridge.sessionId = saved.sessionId;
  }

  if (saved?.sessionId && projectUsable) {
    console.log(
      `Restored state: project=${saved.projectPath}, session=${saved.sessionId.slice(0, 8)}..., ` +
      `model=${saved.model || "default"}, effort=${saved.effort || "default"}`
    );
  } else {
    const resumedId = await bridge.resumeLatestSession();
    console.log(
      resumedId
        ? `Resuming session: ${resumedId.slice(0, 8)}... in ${bridge.projectPath}`
        : `Starting fresh in ${bridge.projectPath}`
    );
  }

  // Global error handler — prevents crashes from unhandled errors
  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    const updateId = ctx.update.update_id;
    console.error(`Error handling update ${updateId}:`, e);
  });

  // Auth middleware — silently drop unauthorized users
  bot.use(async (ctx, next) => {
    if (!ctx.from?.id || !config.allowedUserIds.includes(ctx.from.id)) return;
    await next();
  });

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `VibeIDE connected (${config.provider}).\nProject: \`${bridge.projectPath}\`\n\nCommands:\n/projects — list projects\n/switch — change project\n/new — fresh session\n/stop — interrupt current task\n/status — current state\n/file <path> — send a file`,
      { parse_mode: "Markdown" }
    );
  });

  // /status command
  bot.command("status", async (ctx) => {
    const sessionInfo = bridge.sessionId
      ? `\`${bridge.sessionId.slice(0, 8)}...\``
      : "none (will start on next message)";
    const modelInfo = bridge.model || "default";
    const effortInfo = bridge.effort || "default";
    await ctx.reply(
      `Provider: \`${config.provider}\`\nProject: \`${bridge.projectPath}\`\nSession: ${sessionInfo}\nModel: \`${modelInfo}\`\nEffort: \`${effortInfo}\``,
      { parse_mode: "Markdown" }
    );
  });

  // /help command
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `*Команды:*\n` +
      `/help — это сообщение\n` +
      `/stop — остановить текущую задачу\n` +
      `/new — новая сессия (сброс контекста)\n` +
      `/status — текущий проект и сессия\n` +
      `/model — выбрать модель\n` +
      `/effort — уровень усилий\n` +
      `/projects — список проектов\n` +
      `/switch — переключить проект\n` +
      `/file <путь> — скачать файл с сервера\n\n` +
      `Поддерживает: текст, голос, фото.`,
      { parse_mode: "Markdown" }
    );
  });

  // /model command — show model picker
  bot.command("model", async (ctx) => {
    const models = await bridge.getSupportedModels();
    if (models.length === 0) {
      await ctx.reply(
        "Модели недоступны. Отправь любое сообщение чтобы начать сессию, затем попробуй снова."
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const m of models) {
      const current = bridge.model === m.value ? " ✓" : "";
      keyboard.text(`${m.displayName}${current}`, `model:${m.value}`).row();
    }

    await ctx.reply("Выбери модель:", { reply_markup: keyboard });
  });

  // Handle model selection callback
  bot.callbackQuery(/^model:/, async (ctx) => {
    const modelValue = ctx.callbackQuery.data.slice("model:".length);
    const ok = await bridge.setModel(modelValue);
    await ctx.answerCallbackQuery();
    if (ok) {
      await ctx.editMessageText(`Модель: \`${modelValue}\``, { parse_mode: "Markdown" });
    } else {
      await ctx.editMessageText(`Не удалось переключить модель на \`${modelValue}\``, { parse_mode: "Markdown" });
    }
  });

  // /effort command — show effort level picker
  bot.command("effort", async (ctx) => {
    const efforts = await bridge.getSupportedEfforts();
    if (efforts.length === 0) {
      await ctx.reply("Уровни усилий недоступны. Отправь любое сообщение, затем попробуй снова.");
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const value of efforts) {
      const current = bridge.effort === value ? " ✓" : "";
      keyboard.text(`${describeEffort(value).label}${current}`, `effort:${value}`).row();
    }

    await ctx.reply("Уровень усилий:", { reply_markup: keyboard });
  });

  // Handle effort selection callback
  bot.callbackQuery(/^effort:/, async (ctx) => {
    const effortValue = ctx.callbackQuery.data.slice("effort:".length);
    const ok = await bridge.setEffort(effortValue);
    await ctx.answerCallbackQuery();
    const info = describeEffort(effortValue);
    if (ok) {
      const suffix = info.desc ? ` — ${info.desc}` : "";
      await ctx.editMessageText(`Effort: ${info.label}${suffix}`, { parse_mode: "Markdown" });
    } else {
      await ctx.editMessageText(`Не удалось установить effort: \`${effortValue}\``, { parse_mode: "Markdown" });
    }
  });

  // /stop command — interrupt the running Claude query
  bot.command("stop", async (ctx) => {
    const stopped = await bridge.stop();
    if (!stopped) {
      await ctx.reply("Нечего останавливать.");
    }
  });

  // /new command — fresh session, same project
  bot.command("new", async (ctx) => {
    bridge.clearSession();
    await ctx.reply("Session cleared. Next message starts a fresh conversation.");
  });

  // /file command — send a file from the server to Telegram
  bot.command("file", async (ctx) => {
    const args = ctx.message?.text?.slice("/file".length).trim();
    if (!args) {
      await ctx.reply("Usage: `/file <path>`\nExample: `/file presentation.pdf`", { parse_mode: "Markdown" });
      return;
    }

    // Resolve relative paths from the current project directory
    const filePath = args.startsWith("/") ? args : join(bridge.projectPath, args);

    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch {
      await ctx.reply(`File not found: \`${filePath}\``, { parse_mode: "Markdown" });
      return;
    }

    if (fileStats.isDirectory()) {
      await ctx.reply("Cannot send a directory. Specify a file path.");
      return;
    }

    // Telegram bot API limit: 50 MB
    const sizeMB = fileStats.size / (1024 * 1024);
    if (sizeMB > 50) {
      await ctx.reply(`File too large (${sizeMB.toFixed(1)} MB). Telegram limit is 50 MB.`);
      return;
    }

    try {
      const fileName = filePath.split("/").pop() || "file";
      await ctx.replyWithDocument(new InputFile(createReadStream(filePath), fileName));
    } catch (err: any) {
      console.error("Failed to send file:", err);
      await ctx.reply(`Failed to send file: ${err.message}`);
    }
  });

  // /projects command — list available projects
  bot.command("projects", async (ctx) => {
    const projects = await bridge.listProjects();
    if (projects.length === 0) {
      await ctx.reply("Проектов пока нет — они появятся после первой задачи в каталоге.");
      return;
    }

    const lines = projects.slice(0, 20).map(
      (p, i) => `${i + 1}. **${p.name}** (${formatRelativeTime(p.lastActivity)})\n   \`${p.path}\``
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  // /switch command — show project picker
  bot.command("switch", async (ctx) => {
    const projects = await bridge.listProjects();
    if (projects.length === 0) {
      await ctx.reply("Проектов пока нет — они появятся после первой задачи в каталоге.");
      return;
    }

    // Telegram rejects callback_data over 64 bytes and project paths routinely
    // exceed that, so the buttons carry an index into the list they were built from.
    const choices = projects.slice(0, 20);
    const keyboard = new InlineKeyboard();
    choices.forEach((project, index) => {
      keyboard
        .text(`${project.name} (${formatRelativeTime(project.lastActivity)})`, `switch:${index}`)
        .row();
    });

    const sent = await ctx.reply("Pick a project:", { reply_markup: keyboard });
    switchChoices.set(sent.message_id, choices);
    // Keep the map from growing without bound across a long-running process.
    if (switchChoices.size > 50) {
      switchChoices.delete(switchChoices.keys().next().value!);
    }
  });

  // Handle inline keyboard callbacks for project switching
  bot.callbackQuery(/^switch:/, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const choices = messageId === undefined ? undefined : switchChoices.get(messageId);
    const choice = choices?.[Number(ctx.callbackQuery.data.slice("switch:".length))];
    if (!choice) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Этот список устарел — вызови /switch заново.");
      return;
    }
    const projectPath = choice.path;
    bridge.projectPath = projectPath;
    const resumedId = await bridge.resumeLatestSession();
    bridge.saveState();
    const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
    await ctx.answerCallbackQuery();
    const sessionNote = resumedId
      ? `Resumed session \`${resumedId.slice(0, 8)}...\``
      : "Starting fresh session.";
    await ctx.editMessageText(`Switched to **${name}**\n\`${projectPath}\`\n\n${sessionNote}`, {
      parse_mode: "Markdown",
    });
  });

  // Handle photo messages (images)
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo;
    if (!photo || photo.length === 0) return;

    // Get highest resolution photo
    const largest = photo[photo.length - 1];
    const file = await ctx.api.getFile(largest.file_id);

    if (!file.file_path) {
      await ctx.reply("Could not download image.");
      return;
    }

    // Download the file
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString("base64");

    const ext = file.file_path.split(".").pop()?.toLowerCase() || "jpg";
    const mediaTypeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mediaType = mediaTypeMap[ext] || "image/jpeg";

    const caption = ctx.message.caption || "What do you see in this image?";
    bridge.sendMessage(ctx.chat.id, caption, [
      { data: base64, mediaType },
    ]).catch((err) => {
      console.error("sendMessage error:", err);
    });
  });

  // Handle voice messages — transcribe via whisper.cpp, then forward text to Claude
  bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;

    // getFile can fail with 504 Gateway Timeout for large/slow files — retry once
    let file;
    try {
      file = await ctx.api.getFile(voice.file_id);
    } catch (err: any) {
      console.error(`getFile failed (attempt 1): ${err.message}`);
      // Retry once after a short delay
      try {
        await new Promise((r) => setTimeout(r, 3000));
        file = await ctx.api.getFile(voice.file_id);
      } catch (retryErr: any) {
        console.error(`getFile failed (attempt 2): ${retryErr.message}`);
        await ctx.reply("Не удалось скачать голосовое сообщение. Попробуй ещё раз.");
        return;
      }
    }

    if (!file.file_path) {
      await ctx.reply("Could not download voice message.");
      return;
    }

    // Download the .oga file to a temp location
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const tmpPath = `/tmp/vibeide-voice-${Date.now()}.oga`;

    try {
      await writeFile(tmpPath, buffer);

      // Transcribe via whisper.cpp (ffmpeg converts oga→wav internally)
      const text = await transcribeAudio(tmpPath);
      console.log(`Voice transcribed (${voice.duration}s): ${text.slice(0, 80)}...`);

      // Show the user what was recognized so they can verify
      await ctx.reply(`🎤 _${text}_`, { parse_mode: "Markdown" });

      bridge.sendMessage(ctx.chat.id, text).catch((err) => {
        console.error("sendMessage error:", err);
      });
    } catch (err: any) {
      console.error("Voice transcription error:", err);
      await ctx.reply(`Не удалось распознать голос: ${err.message}`);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  // Handle text messages — forward to Claude
  // NOTE: sendMessage is NOT awaited so the handler returns immediately,
  // allowing Grammy to process the next update (e.g. /stop) without waiting.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return; // Skip unhandled commands
    bridge.sendMessage(ctx.chat.id, text).catch((err) => {
      console.error("sendMessage error:", err);
    });
  });

  return bot;
}
