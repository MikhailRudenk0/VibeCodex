import type { Api, RawApi } from "grammy";

const EDIT_INTERVAL_MS = 300;
const MAX_MESSAGE_LENGTH = 3800; // Leave room for formatting overhead under 4096 limit
// Streaming edits are sent as PLAIN text (Markdown can be mid-token/invalid),
// so keep this free of Markdown markup — otherwise underscores/asterisks show literally.
const PROGRESS_SUFFIX = "\n\n⏳ in progress…";

export class Streamer {
  private api: Api<RawApi>;
  private chatId: number;
  private text = "";
  private messageId: number | null = null;
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private sentMessages: number[] = [];

  constructor(api: Api<RawApi>, chatId: number, initialMessageId?: number) {
    this.api = api;
    this.chatId = chatId;
    // If an acknowledgment message was already sent, reuse it: the first
    // streamed chunk edits that message in place instead of sending a new one.
    this.messageId = initialMessageId ?? null;
  }

  async append(delta: string): Promise<void> {
    if (this.finalized) return;
    this.text += delta;

    // Split into multiple messages while text exceeds max.
    // Uses a while loop to handle cases where a single delta (e.g. a huge
    // <thinking> block) is itself larger than MAX_MESSAGE_LENGTH.
    while (this.text.length > MAX_MESSAGE_LENGTH) {
      const splitAt = this.findSplitPoint(this.text, MAX_MESSAGE_LENGTH);
      const chunk = this.text.slice(0, splitAt);
      const rest = this.text.slice(splitAt);

      this.text = chunk;

      if (this.messageId) {
        // Finalize current message with the chunk (plain-text fallback safe)
        await this.finalizeCurrentMessage();
        this.sentMessages.push(this.messageId);
        this.messageId = null;
      } else {
        // No message yet — send the chunk as a completed plain-text message
        await this.sendPlainChunk(chunk);
      }

      this.text = rest;
    }

    if (!this.messageId && this.text) {
      await this.sendInitial();
    } else if (this.messageId) {
      this.scheduleEdit();
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    // Final text might still exceed MAX (last chunk). Split it.
    while (this.text.length > MAX_MESSAGE_LENGTH) {
      const splitAt = this.findSplitPoint(this.text, MAX_MESSAGE_LENGTH);
      const chunk = this.text.slice(0, splitAt);
      const rest = this.text.slice(splitAt);

      this.text = chunk;

      if (this.messageId) {
        await this.finalizeCurrentMessage();
        this.sentMessages.push(this.messageId);
        this.messageId = null;
      } else {
        await this.sendWithMarkdown(chunk);
      }

      this.text = rest;
    }

    // Send/finalize the last chunk
    if (!this.messageId && this.text) {
      await this.sendWithMarkdown(this.text);
    } else if (this.messageId) {
      await this.finalizeCurrentMessage();
    }
  }

  /** Find a clean place to split text — prefer newline, then space, then hard cut */
  private findSplitPoint(text: string, maxLen: number): number {
    if (text.length <= maxLen) return text.length;

    // Try double-newline (paragraph boundary) — best split
    const lastParagraph = text.lastIndexOf("\n\n", maxLen);
    if (lastParagraph > maxLen * 0.3) return lastParagraph + 1;

    // Try single newline
    const lastNewline = text.lastIndexOf("\n", maxLen);
    if (lastNewline > maxLen * 0.3) return lastNewline + 1;

    // Try space
    const lastSpace = text.lastIndexOf(" ", maxLen);
    if (lastSpace > maxLen * 0.3) return lastSpace + 1;

    // Hard cut
    return maxLen;
  }

  /** Send a completed plain-text chunk (no progress suffix, no Markdown) */
  private async sendPlainChunk(text: string): Promise<void> {
    try {
      const msg = await this.api.sendMessage(this.chatId, text);
      this.sentMessages.push(msg.message_id);
    } catch (e) {
      console.error("Failed to send plain chunk:", e);
    }
  }

  /** Send initial message as plain text with progress indicator */
  private async sendInitial(): Promise<void> {
    const content = this.text || "...";
    try {
      const msg = await this.api.sendMessage(
        this.chatId,
        content + PROGRESS_SUFFIX
      );
      this.messageId = msg.message_id;
      this.lastEditTime = Date.now();
    } catch (e) {
      console.error("Failed to send message:", e);
    }
  }

  private scheduleEdit(): void {
    if (this.editTimer) return;

    const elapsed = Date.now() - this.lastEditTime;
    const delay = Math.max(0, EDIT_INTERVAL_MS - elapsed);

    this.editTimer = setTimeout(async () => {
      this.editTimer = null;
      await this.flushEdit();
    }, delay);
  }

  /** Edit message with plain text + progress indicator (during streaming) */
  private async flushEdit(): Promise<void> {
    if (!this.messageId || !this.text) return;

    try {
      await this.api.editMessageText(
        this.chatId,
        this.messageId,
        this.text + PROGRESS_SUFFIX
      );
      this.lastEditTime = Date.now();
    } catch {
      // Message unchanged or other error — ignore
    }
  }

  /** Final edit: apply Markdown formatting, remove progress indicator */
  private async finalizeCurrentMessage(): Promise<void> {
    if (!this.messageId || !this.text) return;

    try {
      await this.api.editMessageText(
        this.chatId,
        this.messageId,
        this.text,
        { parse_mode: "Markdown" }
      );
      this.lastEditTime = Date.now();
    } catch {
      // Markdown failed — try plain text without progress indicator
      try {
        await this.api.editMessageText(
          this.chatId,
          this.messageId,
          this.text
        );
        this.lastEditTime = Date.now();
      } catch {
        // Message unchanged — ignore
      }
    }
  }

  /** Send a new message directly with Markdown (used in finalize when no messageId yet) */
  private async sendWithMarkdown(content: string): Promise<void> {
    try {
      const msg = await this.api.sendMessage(this.chatId, content, {
        parse_mode: "Markdown",
      });
      this.messageId = msg.message_id;
    } catch {
      // Markdown failed — send plain text
      try {
        const msg = await this.api.sendMessage(this.chatId, content);
        this.messageId = msg.message_id;
      } catch (e) {
        console.error("Failed to send message:", e);
      }
    }
  }
}
