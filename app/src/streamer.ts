import type { Api, RawApi } from "grammy";

// Telegram throttles a bot to roughly one write per second per chat. Codex emits
// hundreds of deltas per answer, so a 300 ms cadence sat far above that limit and
// earned 429s with retry_after up to 19 s.
const EDIT_INTERVAL_MS = Number(process.env.STREAM_EDIT_INTERVAL_MS) || 900;
/** Upper bound for the adaptive backoff applied after a rate limit. */
const MAX_EDIT_INTERVAL_MS = 8000;
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
  /**
   * Telegram applies concurrent edits of one message in completion order, not
   * call order. A throttled edit still in flight when the turn ends would land
   * after the final one and leave the user looking at older text with the
   * progress suffix still on it, so every write goes through this queue.
   */
  private inFlight: Promise<void> = Promise.resolve();
  /** Grows when Telegram pushes back, so one 429 does not become a storm. */
  private editInterval = EDIT_INTERVAL_MS;
  /** Nothing may be sent before this moment; set from Telegram's retry_after. */
  private nextCallAt = 0;

  constructor(api: Api<RawApi>, chatId: number, initialMessageId?: number) {
    this.api = api;
    this.chatId = chatId;
    // If an acknowledgment message was already sent, reuse it: the first
    // streamed chunk edits that message in place instead of sending a new one.
    this.messageId = initialMessageId ?? null;
  }

  /**
   * Performs one Telegram call, waiting out any rate limit Telegram asked for.
   * Previously a failed send left messageId unset, so the next delta retried
   * immediately — one 429 turned into hundreds and the reply never appeared.
   */
  private async call<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = this.nextCallAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

      try {
        return await fn();
      } catch (err: any) {
        const retryAfter = err?.parameters?.retry_after;
        if (typeof retryAfter === "number") {
          this.nextCallAt = Date.now() + (retryAfter + 1) * 1000;
          this.editInterval = Math.min(this.editInterval * 2, MAX_EDIT_INTERVAL_MS);
          continue;
        }
        // Editing a message to its current text is a no-op, not a failure.
        if (/message is not modified/i.test(String(err?.description ?? err))) return null;
        console.error(`${label}: ${err?.description ?? err}`);
        return null;
      }
    }
    console.error(`${label}: Telegram kept rate limiting; giving up`);
    return null;
  }

  /** Runs one Telegram write after everything already queued. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.inFlight.then(task);
    this.inFlight = next.catch(() => {});
    return next;
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
        await this.enqueue(() => this.finalizeCurrentMessage());
        this.sentMessages.push(this.messageId);
        this.messageId = null;
      } else {
        // No message yet — send the chunk as a completed plain-text message
        await this.enqueue(() => this.sendPlainChunk(chunk));
      }

      this.text = rest;
    }

    if (!this.messageId && this.text) {
      await this.enqueue(() => this.sendInitial());
    } else if (this.messageId) {
      this.scheduleEdit();
    }
  }

  async finalize(statusLine?: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    // A throttled edit may already be on the wire; its text is older than ours.
    await this.inFlight;

    // Append status line to the very end of the response
    if (statusLine) {
      this.text += "\n\n" + statusLine;
    }

    // Final text might still exceed MAX (last chunk). Split it.
    while (this.text.length > MAX_MESSAGE_LENGTH) {
      const splitAt = this.findSplitPoint(this.text, MAX_MESSAGE_LENGTH);
      const chunk = this.text.slice(0, splitAt);
      const rest = this.text.slice(splitAt);

      this.text = chunk;

      if (this.messageId) {
        await this.enqueue(() => this.finalizeCurrentMessage());
        this.sentMessages.push(this.messageId);
        this.messageId = null;
      } else {
        await this.enqueue(() => this.sendWithMarkdown(chunk));
      }

      this.text = rest;
    }

    // Send/finalize the last chunk
    if (!this.messageId && this.text) {
      await this.enqueue(() => this.sendWithMarkdown(this.text));
    } else if (this.messageId) {
      await this.enqueue(() => this.finalizeCurrentMessage());
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
    const msg = await this.call("Failed to send plain chunk", () =>
      this.api.sendMessage(this.chatId, text)
    );
    if (msg) this.sentMessages.push(msg.message_id);
  }

  /** Send initial message as plain text with progress indicator */
  private async sendInitial(): Promise<void> {
    const content = this.text || "...";
    const msg = await this.call("Failed to send message", () =>
      this.api.sendMessage(this.chatId, content + PROGRESS_SUFFIX)
    );
    if (msg) {
      this.messageId = msg.message_id;
      this.lastEditTime = Date.now();
    }
  }

  private scheduleEdit(): void {
    if (this.editTimer) return;

    const elapsed = Date.now() - this.lastEditTime;
    const delay = Math.max(0, this.editInterval - elapsed);

    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.enqueue(() => this.flushEdit());
    }, delay);
  }

  /** Edit message with plain text + progress indicator (during streaming) */
  private async flushEdit(): Promise<void> {
    if (!this.messageId || !this.text) return;
    // Intermediate frames are disposable: if one is lost the next carries the
    // same text plus more. Only the closing edit has to land.
    const messageId = this.messageId;
    const text = this.text;
    await this.call("Progress edit", () =>
      this.api.editMessageText(this.chatId, messageId, text + PROGRESS_SUFFIX)
    );
    this.lastEditTime = Date.now();
  }

  /** Final edit: apply Markdown formatting, remove progress indicator */
  private async finalizeCurrentMessage(): Promise<void> {
    if (!this.messageId || !this.text) return;
    const messageId = this.messageId;
    const text = this.text;

    try {
      await this.call("Final edit", () =>
        this.api.editMessageText(this.chatId, messageId, text, { parse_mode: "Markdown" })
      );
    } finally {
      this.lastEditTime = Date.now();
    }

    // Markdown may be rejected mid-token; the plain-text pass is what guarantees
    // the progress suffix is gone, so it runs whenever the first one did not land.
    await this.call("Final edit (plain)", () =>
      this.api.editMessageText(this.chatId, messageId, text)
    );
  }

  /** Send a new message directly with Markdown (used in finalize when no messageId yet) */
  private async sendWithMarkdown(content: string): Promise<void> {
    const formatted = await this.call("Markdown send", () =>
      this.api.sendMessage(this.chatId, content, { parse_mode: "Markdown" })
    );
    if (formatted) {
      this.messageId = formatted.message_id;
      return;
    }
    const plain = await this.call("Failed to send message", () =>
      this.api.sendMessage(this.chatId, content)
    );
    if (plain) this.messageId = plain.message_id;
  }
}
