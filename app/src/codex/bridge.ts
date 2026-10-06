import type { Api, RawApi } from "grammy";
import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { Streamer } from "../streamer.js";
import type { ProjectInfo } from "../projects.js";
import { AppServer, type AppServerNotification } from "./app-server.js";

// VIBEIDE_STATE_DIR lets tests keep their own state instead of clobbering the
// running bot's current project and thread.
const STATE_DIR = process.env.VIBEIDE_STATE_DIR || join(homedir(), ".local", "state", "vibeide");
const STATE_FILE = join(STATE_DIR, "state-codex.json");

/** Effort levels Codex accepts; the picker in bot.ts renders this order. */
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

export interface ModelChoice {
  value: string;
  displayName: string;
}

export interface CodexBridgeOptions {
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  /** When true, a one-line notice per shell command is folded into the streamed reply. */
  toolNotices?: boolean;
}

interface QueuedMessage {
  chatId: number;
  text: string;
  images?: { data: string; mediaType: string }[];
}

interface SavedState {
  sessionId: string;
  projectPath: string;
  model?: string;
  effort?: CodexEffort;
}

const SANDBOX_POLICY = {
  "read-only": { type: "readOnly" as const },
  "workspace-write": { type: "workspaceWrite" as const },
  "danger-full-access": { type: "dangerFullAccess" as const },
};

export class CodexBridge {
  projectPath: string;
  /** Codex calls it a thread; the rest of the bot calls it a session. Same thing. */
  sessionId: string | undefined;
  model: string | undefined;
  effort: CodexEffort | undefined;

  private readonly api: Api<RawApi>;
  private readonly server: AppServer;
  private readonly options: Required<CodexBridgeOptions>;

  private cachedModels: ModelChoice[] = [];
  private isProcessing = false;
  private pendingMessage: QueuedMessage | null = null;

  private currentStreamer: Streamer | null = null;
  private currentTurnId: string | undefined;
  private finishTurn: (() => void) | null = null;
  /** Text already pushed to Telegram per item, so a late item/completed adds only the tail. */
  private streamedByItem = new Map<string, string>();
  private lastUsage: { input: number; output: number } | null = null;
  /** app-server generation the current thread belongs to; -1 means "not live". */
  private threadGeneration = -1;
  /** Everything streamed during this turn, used to avoid echoing a message twice. */
  private streamedThisTurn = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Model/effort actually in force, reported by the server — may differ from the override. */
  private effectiveModel: string | undefined;
  private effectiveEffort: string | undefined;
  private turnError: string | null = null;
  /**
   * Turn ids already reported complete. A turn's completion can land before
   * turn/start returns its id, and a previous turn's completion can land after
   * the next turn is armed — matching on id handles both.
   */
  private finishedTurnIds = new Set<string>();

  constructor(api: Api<RawApi>, projectPath?: string, options: CodexBridgeOptions = {}) {
    this.api = api;
    this.projectPath = projectPath || process.cwd();
    this.options = {
      sandboxMode: options.sandboxMode ?? "danger-full-access",
      approvalPolicy: options.approvalPolicy ?? "never",
      toolNotices: options.toolNotices ?? false,
    };
    this.server = new AppServer(
      (notification) => this.handleNotification(notification),
      (message) => console.error(message),
      {
        onDisconnect: (error) => {
          // A dead subprocess cannot deliver turn/completed, so release the turn
          // instead of leaving the bot stuck on isProcessing forever.
          this.threadGeneration = -1;
          if (this.finishTurn) {
            this.turnError = error.message;
            this.finishTurn();
          }
        },
      }
    );
  }

  /** Shuts down the app-server subprocess. The bot keeps it alive; tests do not. */
  close(): void {
    this.server.close();
  }

  // ---------------------------------------------------------------- state

  static async loadState(): Promise<SavedState | null> {
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

  clearSession(): void {
    this.sessionId = undefined;
    this.saveState();
  }

  // ------------------------------------------------------------- projects

  /**
   * Codex has no per-project folders on disk the way Claude Code does, so the
   * project list is derived from recent threads grouped by working directory.
   */
  async listProjects(): Promise<ProjectInfo[]> {
    let threads: any[];
    try {
      const result = await this.server.request("thread/list", { limit: 100 });
      threads = result?.data ?? [];
    } catch {
      return [];
    }

    const byPath = new Map<string, ProjectInfo>();
    for (const thread of threads) {
      const path = thread?.cwd;
      // Threads outlive their directories; a deleted path is not a project.
      if (!path || !existsSync(path)) continue;
      const activity = new Date((thread.updatedAt ?? thread.createdAt ?? 0) * 1000);
      const existing = byPath.get(path);
      if (existing && existing.lastActivity >= activity) continue;
      byPath.set(path, {
        name: path.split("/").filter(Boolean).pop() || path,
        path,
        encodedName: path,
        lastActivity: activity,
      });
    }

    return [...byPath.values()].sort(
      (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()
    );
  }

  async resumeLatestSession(): Promise<string | undefined> {
    try {
      const result = await this.server.request("thread/list", { limit: 100 });
      const match = (result?.data ?? [])
        .filter((thread: any) => thread?.cwd === this.projectPath)
        .sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      this.sessionId = match?.id;
    } catch {
      this.sessionId = undefined;
    }
    return this.sessionId;
  }

  // --------------------------------------------------------------- models

  async getSupportedModels(): Promise<ModelChoice[]> {
    if (this.cachedModels.length > 0) return this.cachedModels;
    try {
      const result = await this.server.request("model/list", {});
      this.cachedModels = (result?.data ?? [])
        .filter((model: any) => !model.hidden)
        .map((model: any) => ({
          value: model.id ?? model.model,
          displayName: model.displayName ?? model.id ?? model.model,
        }))
        .filter((model: ModelChoice) => model.value);
      return this.cachedModels;
    } catch {
      return [];
    }
  }

  /**
   * Codex fixes model and effort when the thread starts, so a change only takes
   * effect on the next turn — which is why both are also sent with every
   * `turn/start` as an override.
   */
  async setModel(model: string): Promise<boolean> {
    this.model = model;
    this.saveState();
    return true;
  }

  async setEffort(effort: CodexEffort): Promise<boolean> {
    this.effort = effort;
    this.saveState();
    return true;
  }

  // ------------------------------------------------------------ execution

  async stop(): Promise<boolean> {
    if (!this.isProcessing || !this.sessionId || !this.currentTurnId) return false;
    try {
      await this.server.request("turn/interrupt", {
        threadId: this.sessionId,
        turnId: this.currentTurnId,
      });
    } catch {
      // Already finished — fall through and close the message anyway.
    }
    if (this.currentStreamer) {
      await this.currentStreamer.append("\n\n⛔ Остановлено");
    }
    this.finishTurn?.();
    return true;
  }

  async sendMessage(
    chatId: number,
    text: string,
    images?: { data: string; mediaType: string }[]
  ): Promise<void> {
    if (this.isProcessing) {
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
    this.lastUsage = null;
    this.turnError = null;
    this.streamedByItem.clear();
    this.streamedThisTurn = "";
    this.finishedTurnIds.clear();

    let ackMessageId: number | undefined;
    try {
      const ack = await this.api.sendMessage(chatId, "⏳ Взял в работу…");
      ackMessageId = ack.message_id;
    } catch {
      // Streamer sends its own first message if the ack failed.
    }

    const streamer = new Streamer(this.api, chatId, ackMessageId);
    this.currentStreamer = streamer;
    const tempImages: string[] = [];
    let statusLine: string | undefined;

    try {
      await this.ensureThread();

      const input: Record<string, any>[] = [];
      if (text) input.push({ type: "text", text });
      for (const image of images ?? []) {
        const path = await this.writeTempImage(image);
        tempImages.push(path);
        input.push({ type: "localImage", path });
      }
      if (input.length === 0) input.push({ type: "text", text: "" });

      const turnEnded = new Promise<void>((resolve) => {
        this.finishTurn = () => {
          this.finishTurn = null;
          resolve();
        };
      });

      const turn = await this.server.request("turn/start", {
        threadId: this.sessionId,
        input,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        cwd: this.projectPath,
        approvalPolicy: this.options.approvalPolicy,
        sandboxPolicy: SANDBOX_POLICY[this.options.sandboxMode],
      });
      this.currentTurnId = turn?.turn?.id;
      if (this.currentTurnId && this.finishedTurnIds.has(this.currentTurnId)) {
        this.finishTurn?.();
      }

      this.armIdleWatchdog();
      await turnEnded;

      if (this.turnError) await streamer.append(`\n\nError: ${this.turnError}`);
      statusLine = this.buildStatusLine();
    } catch (err: any) {
      await streamer.append(`\n\nBridge error: ${err?.message || err}`);
    } finally {
      this.clearIdleWatchdog();
      this.finishTurn = null;
      await streamer.finalize(statusLine);
      this.currentStreamer = null;
      this.currentTurnId = undefined;
      this.isProcessing = false;
      for (const path of tempImages) await unlink(path).catch(() => {});

      const next = this.pendingMessage;
      if (next) {
        this.pendingMessage = null;
        this.sendMessage(next.chatId, next.text, next.images).catch((err) => {
          console.error("Queued sendMessage error:", err);
        });
      }
    }
  }

  // ------------------------------------------------------------- internals

  private async ensureThread(): Promise<void> {
    await this.server.start();

    // A thread already open in this app-server needs nothing: resuming it again
    // trips the "thread already has an active writer" conflict.
    if (this.sessionId && this.threadGeneration === this.server.generation) return;

    if (this.sessionId) {
      try {
        await this.server.request("thread/resume", {
          threadId: this.sessionId,
          cwd: this.projectPath,
        });
        this.threadGeneration = this.server.generation;
        return;
      } catch (err) {
        console.error(`Could not resume thread ${this.sessionId}, starting a new one:`, err);
        this.sessionId = undefined;
      }
    }

    const result = await this.server.request("thread/start", {
      cwd: this.projectPath,
      approvalPolicy: this.options.approvalPolicy,
      sandboxPolicy: SANDBOX_POLICY[this.options.sandboxMode],
      ...(this.model ? { model: this.model } : {}),
    });
    this.sessionId = result?.thread?.id;
    if (!this.sessionId) throw new Error("app-server did not return a thread id");
    this.effectiveModel = result?.thread?.model ?? this.effectiveModel;
    this.effectiveEffort = result?.thread?.reasoningEffort ?? this.effectiveEffort;
    this.threadGeneration = this.server.generation;
    this.saveState();
  }

  private async writeTempImage(image: { data: string; mediaType: string }): Promise<string> {
    const extension = image.mediaType.split("/")[1] || "jpg";
    const path = join(tmpdir(), `vibeide-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
    await writeFile(path, Buffer.from(image.data, "base64"));
    return path;
  }

  private handleNotification({ method, params }: AppServerNotification): void {
    if (params.threadId && this.sessionId && params.threadId !== this.sessionId) return;
    if (this.idleTimer) this.armIdleWatchdog();
    const streamer = this.currentStreamer;

    switch (method) {
      case "item/agentMessage/delta": {
        if (!streamer || !params.delta) return;
        const itemId: string = params.itemId ?? "";
        this.streamedByItem.set(itemId, (this.streamedByItem.get(itemId) ?? "") + params.delta);
        this.streamedThisTurn += params.delta;
        void streamer.append(params.delta);
        return;
      }

      case "item/started": {
        if (!streamer || !this.options.toolNotices) return;
        const item = params.item ?? {};
        if (item.type === "commandExecution" && item.command) {
          void streamer.append(`\n\n🔧 ${String(item.command).slice(0, 120)}\n`);
        }
        return;
      }

      case "item/completed": {
        const item = params.item ?? {};
        if (item.type !== "agentMessage" || !streamer) return;
        // Deltas usually cover the whole message; append only what is missing so
        // a model that skips streaming still produces a complete answer.
        const streamed = this.streamedByItem.get(item.id ?? "") ?? "";
        const full: string = item.text ?? "";
        if (!full) return;
        if (full.startsWith(streamed)) {
          const tail = full.slice(streamed.length);
          if (tail) void streamer.append(tail);
        } else if (!this.streamedThisTurn.includes(full)) {
          // Deltas and the final item disagree, and this text is genuinely new.
          void streamer.append(full);
          this.streamedThisTurn += full;
        }
        this.streamedByItem.set(item.id ?? "", full);
        return;
      }

      case "thread/settings/updated": {
        const settings = params.threadSettings ?? {};
        if (settings.model) this.effectiveModel = settings.model;
        if (settings.reasoningEffort) this.effectiveEffort = settings.reasoningEffort;
        return;
      }

      case "thread/tokenUsage/updated": {
        const total = params.tokenUsage?.total;
        if (total) {
          this.lastUsage = {
            input: total.inputTokens ?? 0,
            output: total.outputTokens ?? 0,
          };
        }
        return;
      }

      case "error": {
        this.turnError = params.message ?? "unknown error";
        this.finishTurn?.();
        return;
      }

      case "turn/failed":
      case "turn/completed": {
        if (method === "turn/failed") {
          this.turnError = params.error?.message ?? "turn failed";
        }
        const turnId: string | undefined = params.turn?.id ?? params.turnId;
        if (!turnId) {
          this.finishTurn?.();
          return;
        }
        this.finishedTurnIds.add(turnId);
        if (turnId === this.currentTurnId) this.finishTurn?.();
        return;
      }
    }
  }

  /**
   * Releases a turn that has gone completely silent. Long tasks keep emitting
   * notifications, so prolonged silence means something was lost, not slow.
   */
  private armIdleWatchdog(): void {
    this.clearIdleWatchdog();
    this.idleTimer = setTimeout(() => {
      if (!this.finishTurn) return;
      this.turnError = "Codex молчит 15 минут — ход прерван";
      this.finishTurn();
    }, 15 * 60_000);
  }

  private clearIdleWatchdog(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private buildStatusLine(): string {
    const parts: string[] = [];
    const model = this.model ?? this.effectiveModel;
    const effort = this.effort ?? this.effectiveEffort;
    if (model) parts.push(model);
    if (effort) parts.push(effort);

    if (this.lastUsage) {
      const format = (n: number) =>
        n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M" : n >= 1_000 ? (n / 1_000).toFixed(0) + "k" : String(n);
      parts.push(`${format(this.lastUsage.input)}↓ ${format(this.lastUsage.output)}↑`);
    }

    return parts.length > 0 ? `\`${parts.join(" · ")}\`` : "";
  }
}
