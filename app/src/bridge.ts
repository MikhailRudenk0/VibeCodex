import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo, EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Api, RawApi } from "grammy";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { Streamer } from "./streamer.js";
import { findLatestSessionId } from "./projects.js";

const STATE_DIR = join(homedir(), ".local", "state", "vibeide");
const STATE_FILE = join(STATE_DIR, "state.json");

interface QueuedMessage {
  chatId: number;
  text: string;
  images?: { data: string; mediaType: string }[];
}

export type { ModelInfo, EffortLevel };

export class Bridge {
  projectPath: string;
  sessionId: string | undefined;
  model: string | undefined;
  effort: EffortLevel | undefined;
  private cachedModels: ModelInfo[] = [];
  private isProcessing = false;
  private api: Api<RawApi>;
  private currentQuery: ReturnType<typeof query> | null = null;
  private currentStreamer: Streamer | null = null;
  private pendingMessage: QueuedMessage | null = null;

  constructor(api: Api<RawApi>, projectPath?: string) {
    this.api = api;
    this.projectPath = projectPath || process.cwd();
  }

  async resumeLatestSession(): Promise<string | undefined> {
    this.sessionId = await findLatestSessionId(this.projectPath);
    return this.sessionId;
  }

  clearSession(): void {
    this.sessionId = undefined;
    this.saveState();
  }

  static async loadState(): Promise<{
    sessionId: string;
    projectPath: string;
    model?: string;
    effort?: EffortLevel;
  } | null> {
    try {
      const data = JSON.parse(await readFile(STATE_FILE, "utf-8"));
      if (data.sessionId && data.projectPath) return data;
    } catch {}
    return null;
  }

  saveState(): void {
    const data = JSON.stringify({
      sessionId: this.sessionId,
      projectPath: this.projectPath,
      model: this.model,
      effort: this.effort,
    });
    mkdir(STATE_DIR, { recursive: true })
      .then(() => writeFile(STATE_FILE, data))
      .catch(() => {});
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    if (this.cachedModels.length > 0) return this.cachedModels;
    if (!this.currentQuery) return [];
    try {
      this.cachedModels = await this.currentQuery.supportedModels();
      return this.cachedModels;
    } catch {
      return [];
    }
  }

  async setModel(model: string): Promise<boolean> {
    this.model = model;
    this.saveState();
    if (this.currentQuery) {
      try {
        await this.currentQuery.setModel(model);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  async setEffort(effort: EffortLevel): Promise<boolean> {
    this.effort = effort;
    this.saveState();
    if (this.currentQuery) {
      try {
        await this.currentQuery.applyFlagSettings({ effortLevel: effort });
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  async stop(): Promise<boolean> {
    if (!this.currentQuery || !this.isProcessing) return false;
    try {
      await this.currentQuery.interrupt();
    } catch {
      // interrupt may throw if already finished
    }
    if (this.currentStreamer) {
      await this.currentStreamer.append("\n\n⛔ Остановлено");
      await this.currentStreamer.finalize();
    }
    this.currentQuery = null;
    this.currentStreamer = null;
    this.isProcessing = false;
    return true;
  }

  async sendMessage(
    chatId: number,
    text: string,
    images?: { data: string; mediaType: string }[]
  ): Promise<void> {
    if (this.isProcessing) {
      // Queue the message — only keep the latest one (newer replaces older)
      const hadPending = this.pendingMessage !== null;
      this.pendingMessage = { chatId, text, images };
      await this.api.sendMessage(
        chatId,
        hadPending
          ? "⏳ Заменил предыдущее ожидающее сообщение. Приступлю, когда закончу текущее."
          : "⏳ Принял. Приступлю, когда закончу текущее."
      );
      return;
    }

    this.isProcessing = true;

    // Instant acknowledgment so the user sees the request was accepted right
    // away, even before Claude produces its first token. The streamer then
    // edits THIS message in place as the answer streams in (no extra clutter).
    let ackMessageId: number | undefined;
    try {
      const ack = await this.api.sendMessage(chatId, "⏳ Взял в работу…");
      ackMessageId = ack.message_id;
    } catch {
      // If the ack fails, the streamer just sends its own first message.
    }

    const streamer = new Streamer(this.api, chatId, ackMessageId);
    this.currentStreamer = streamer;

    try {
      let promptInput: any;

      if (images && images.length > 0) {
        // Use content blocks for images
        const content: any[] = [];
        if (text) {
          content.push({ type: "text", text });
        }
        for (const img of images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
              data: img.data,
            },
          });
        }

        // For images, we need streaming input mode
        async function* generateMessages() {
          yield {
            type: "user" as const,
            message: {
              role: "user" as const,
              content,
            },
          };
        }
        promptInput = generateMessages();
      } else {
        promptInput = text;
      }

      this.currentQuery = query({
        prompt: promptInput,
        options: {
          cwd: this.projectPath,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          ...(this.model ? { model: this.model } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          allowedTools: [
            "Read",
            "Edit",
            "Write",
            "Bash",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
            "Task",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["project"],
        },
      });

      if (this.cachedModels.length === 0) {
        this.currentQuery.supportedModels().then((models) => {
          this.cachedModels = models;
        }).catch(() => {});
      }

      for await (const message of this.currentQuery) {
        // Capture session ID from any message
        if ("session_id" in message && message.session_id) {
          this.sessionId = message.session_id;
          this.saveState();
        }

        if (message.type === "assistant" && message.message) {
          // Extract text from content blocks
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                await streamer.append(block.text);
              }
            }
          }
        }

        if (message.type === "result") {
          if (message.is_error && "errors" in message) {
            const errors = (message as any).errors as string[];
            if (errors?.length) {
              await streamer.append(`\n\nError: ${errors.join("\n")}`);
            }
          }
        }
      }
    } catch (err: any) {
      await streamer.append(`\n\nBridge error: ${err.message || err}`);
    } finally {
      await streamer.finalize();
      this.currentQuery = null;
      this.currentStreamer = null;
      this.isProcessing = false;

      // Process queued message if any
      const next = this.pendingMessage;
      if (next) {
        this.pendingMessage = null;
        this.sendMessage(next.chatId, next.text, next.images).catch((err) => {
          console.error("Queued sendMessage error:", err);
        });
      }
    }
  }
}
