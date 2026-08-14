import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { exec } from "child_process";
import { createReadStream } from "fs";
import { writeFile, unlink, stat } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Config } from "./config.js";
import { Bridge } from "./bridge.js";
import {
  listProjects,
  formatRelativeTime,
  type ProjectInfo,
} from "./projects.js";

function transcribeAudio(audioPath: string): Promise<string> {
  // Resolve transcribe.sh relative to the project root (two levels up from app/src/)
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const script = join(projectRoot, "bin", "transcribe.sh");

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
  const bridge = new Bridge(bot.api, initialProjectPath);

  // Auto-resume the latest session for this project
  const resumedId = await bridge.resumeLatestSession();
  if (resumedId) {
    console.log(`Resuming session: ${resumedId.slice(0, 8)}...`);
  }

  // Auth middleware — silently drop unauthorized users
  bot.use(async (ctx, next) => {
    if (!ctx.from?.id || !config.allowedUserIds.includes(ctx.from.id)) return;
    await next();
  });

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `VibeIDE connected.\nProject: \`${bridge.projectPath}\`\n\nCommands:\n/projects — list projects\n/switch — change project\n/new — fresh session\n/status — current state\n/file <path> — send a file`,
      { parse_mode: "Markdown" }
    );
  });

  // /status command
  bot.command("status", async (ctx) => {
    const sessionInfo = bridge.sessionId
      ? `\`${bridge.sessionId.slice(0, 8)}...\``
      : "none (will start on next message)";
    await ctx.reply(
      `Project: \`${bridge.projectPath}\`\nSession: ${sessionInfo}`,
      { parse_mode: "Markdown" }
    );
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
    const projects = await listProjects();
    if (projects.length === 0) {
      await ctx.reply("No projects found in ~/.claude/projects/");
      return;
    }

    const lines = projects.slice(0, 20).map(
      (p, i) => `${i + 1}. **${p.name}** (${formatRelativeTime(p.lastActivity)})\n   \`${p.path}\``
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  // /switch command — show project picker
  bot.command("switch", async (ctx) => {
    const projects = await listProjects();
    if (projects.length === 0) {
      await ctx.reply("No projects found in ~/.claude/projects/");
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const project of projects.slice(0, 10)) {
      keyboard
        .text(
          `${project.name} (${formatRelativeTime(project.lastActivity)})`,
          `switch:${project.path}`
        )
        .row();
    }

    await ctx.reply("Pick a project:", { reply_markup: keyboard });
  });

  // Handle inline keyboard callbacks for project switching
  bot.callbackQuery(/^switch:/, async (ctx) => {
    const projectPath = ctx.callbackQuery.data.slice("switch:".length);
    bridge.projectPath = projectPath;
    const resumedId = await bridge.resumeLatestSession();
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
    await bridge.sendMessage(ctx.chat.id, caption, [
      { data: base64, mediaType },
    ]);
  });

  // Handle voice messages — transcribe via whisper.cpp, then forward text to Claude
  bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    const file = await ctx.api.getFile(voice.file_id);

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

      await bridge.sendMessage(ctx.chat.id, text);
    } catch (err: any) {
      console.error("Voice transcription error:", err);
      await ctx.reply(`Не удалось распознать голос: ${err.message}`);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  // Handle text messages — forward to Claude
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return; // Skip unhandled commands
    await bridge.sendMessage(ctx.chat.id, text);
  });

  return bot;
}
