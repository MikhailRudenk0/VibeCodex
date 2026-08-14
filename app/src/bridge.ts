import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Api, RawApi } from "grammy";
import { Streamer } from "./streamer.js";
import { findLatestSessionId } from "./projects.js";

export class Bridge {
  projectPath: string;
  sessionId: string | undefined;
  private isProcessing = false;
  private api: Api<RawApi>;

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
  }

  async sendMessage(
    chatId: number,
    text: string,
    images?: { data: string; mediaType: string }[]
  ): Promise<void> {
    if (this.isProcessing) {
      await this.api.sendMessage(
        chatId,
        "Still thinking on your last message... please wait."
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

      const conversation = query({
        prompt: promptInput,
        options: {
          cwd: this.projectPath,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
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

      for await (const message of conversation) {
        // Capture session ID from any message
        if ("session_id" in message && message.session_id) {
          this.sessionId = message.session_id;
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
      this.isProcessing = false;
    }
  }
}
