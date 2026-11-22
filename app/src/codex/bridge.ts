import { audit } from "../audit.js";
import type { Api, RawApi } from "grammy";
import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Streamer } from "../streamer.js";
import type { ProjectInfo } from "../projects.js";
import { AppServer, type AppServerNotification } from "./app-server.js";
import { stateDir, stateFile } from "../state.js";
import { ProjectScope } from "../project-scope.js";
import { SEND_FILE_TOOL, FILE_DELIVERY_INSTRUCTIONS, sendProjectFile, toolResult, type ToolResult } from "../send-file.js";
import { FileGateway } from "../file-gateway.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";


/**
 * Effort levels differ per model (gpt-6-luna has no `ultra`, and no model has
 * `minimal`), so the real list comes from model/list rather than a constant here.
 */
export type CodexEffort = string;

export interface ModelChoice {
  value: string;
  displayName: string;
}

export interface CodexBridgeOptions {
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  /** When true, a one-line notice per shell command is folded into the streamed reply. */
  toolNotices?: boolean;
  allowedProjectRoot?: string;
  fileDeliveryMcp?: boolean;
}

interface QueuedMessage {
  chatId: number;
  text: string;
  images?: { data: string; mediaType: string }[];
  messageThreadId?: number;
}

interface SavedState {
  /** Absent after /new — the project and preferences still have to survive. */
  sessionId?: string;
  projectPath: string;
  model?: string;
  effort?: CodexEffort;
}

// turn/start takes a structured policy; thread/start takes the plain mode string.
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
  private readonly options: Required<Omit<CodexBridgeOptions, "allowedProjectRoot">>;
  private readonly scope?: ProjectScope;
  private activeDelivery: { chatId: number; cwd: string; messageThreadId?: number; controller: AbortController } | null = null;
  private fileGateway?: FileGateway;
  private fileGatewayKey = "";
  private fileGatewayContext?: { chatId: number; cwd: string; messageThreadId?: number };
  private toolCalls = new Map<string, Promise<ToolResult>>();

  get busy(): boolean { return this.isProcessing; }

  private cachedModels: ModelChoice[] = [];
  private modelEfforts = new Map<string, string[]>();
  private isProcessing = false;
  private pendingMessage: QueuedMessage | null = null;

  private currentStreamer: Streamer | null = null;
  private currentTurnId: string | undefined;
  private finishTurn: (() => void) | null = null;
  /** Text already pushed to Telegram per item, so a late item/completed adds only the tail. */
  private streamedByItem = new Map<string, string>();
  private lastUsage: { input: number; output: number } | null = null;
  /** Which thread is actually open, and in which app-server instance. */
  private openThread: { id: string; generation: number } | null = null;
  /**
   * Streamer.append is not reentrant — it awaits Telegram calls while mutating
   * its own buffer — so every append from the notification handler is chained
   * onto the previous one instead of being fired and forgotten.
   */
  private appendChain: Promise<void> = Promise.resolve();
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
    if (options.allowedProjectRoot) {
      this.scope = new ProjectScope(options.allowedProjectRoot);
      this.projectPath = this.scope.directory(this.projectPath);
    }
    this.options = {
      sandboxMode: options.sandboxMode ?? "danger-full-access",
      approvalPolicy: options.approvalPolicy ?? "never",
      toolNotices: options.toolNotices ?? false,
      fileDeliveryMcp: options.fileDeliveryMcp ?? false,
    };
    if (this.scope && this.options.fileDeliveryMcp) this.fileGateway = new FileGateway(async input => {
      const bound = this.fileGatewayContext, active = this.activeDelivery;
      if (!this.fileGatewayKey || input.key !== this.fileGatewayKey || !bound || !active ||
          bound.chatId !== active.chatId || bound.cwd !== active.cwd || bound.messageThreadId !== active.messageThreadId)
        return toolResult(false, "This file tool is no longer attached to the active conversation");
      return this.handleToolCall({ tool: "send_file", threadId: this.sessionId, turnId: this.currentTurnId,
        callId: input.requestId, arguments: input.arguments });
    });
    this.server = new AppServer(
      (notification) => this.handleNotification(notification),
      (message) => console.error(message),
      {
        onToolCall: params => this.handleToolCall(params),
        onDisconnect: (error) => {
          // A dead subprocess cannot deliver turn/completed, so release the turn
          // instead of leaving the bot stuck on isProcessing forever.
          audit("codex.disconnect", { threadId: this.sessionId });
          this.openThread = null;
          this.activeDelivery?.controller.abort();
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
    this.activeDelivery?.controller.abort();
    this.server.close();
    void this.fileGateway?.close();
  }

  // ---------------------------------------------------------------- state

  static async loadState(): Promise<SavedState | null> {
    try {
      const data = JSON.parse(await readFile(stateFile("state-codex"), "utf-8"));
      if (data.projectPath) return data;
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
    mkdir(stateDir(), { recursive: true })
      .then(() => writeFile(stateFile("state-codex"), data))
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
      const savedPath = thread?.cwd;
      // Canonicalize old paths too, so directory migrations can preserve history
      // through a compatibility symlink without duplicating /switch entries.
      if (!savedPath || !existsSync(savedPath) || (this.scope && !this.scope.allowsDirectory(savedPath))) continue;
      const path = this.scope ? this.scope.directory(savedPath) : savedPath;
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
      if (this.scope) this.projectPath = this.scope.directory(this.projectPath);
      const result = await this.server.request("thread/list", { limit: 100 });
      const match = (result?.data ?? [])
        .filter((thread: any) => {
          if (!this.scope) return thread?.cwd === this.projectPath;
          return thread?.cwd && this.scope.allowsDirectory(thread.cwd) &&
            this.scope.directory(thread.cwd) === this.projectPath;
        })
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
      const available = (result?.data ?? []).filter((model: any) => !model.hidden);
      for (const model of available) {
        const id = model.id ?? model.model;
        const efforts = (model.supportedReasoningEfforts ?? [])
          .map((entry: any) => entry.reasoningEffort)
          .filter(Boolean);
        if (id && efforts.length) this.modelEfforts.set(id, efforts);
      }
      this.cachedModels = available
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

  /** Effort levels the model in use actually accepts. */
  async getSupportedEfforts(): Promise<string[]> {
    await this.getSupportedModels();
    const current = this.model ?? this.effectiveModel;
    const forCurrent = current ? this.modelEfforts.get(current) : undefined;
    if (forCurrent?.length) return forCurrent;
    // Unknown model: offer only what every known model supports.
    const lists = [...this.modelEfforts.values()];
    if (lists.length === 0) return [];
    return lists.reduce((common, list) => common.filter((e) => list.includes(e)));
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

  /** Queues text behind everything already queued for this turn. */
  private queueAppend(text: string): void {
    const streamer = this.currentStreamer;
    if (!streamer || !text) return;
    this.appendChain = this.appendChain
      .then(() => streamer.append(text))
      .catch((err) => console.error("Streamer append failed:", err));
  }

  async stop(): Promise<boolean> {
    if (!this.isProcessing || !this.sessionId || !this.currentTurnId) return false;
    this.activeDelivery?.controller.abort();
    try {
      await this.server.request("turn/interrupt", {
        threadId: this.sessionId,
        turnId: this.currentTurnId,
      });
    } catch {
      // Already finished — fall through and close the message anyway.
    }
    this.queueAppend("\n\n⛔ Остановлено");
    this.finishTurn?.();
    return true;
  }

  async sendMessage(
    chatId: number,
    text: string,
    images?: { data: string; mediaType: string }[],
    messageThreadId?: number
  ): Promise<void> {
    if (this.isProcessing) {
      const hadPending = this.pendingMessage !== null;
      audit("turn.queued", { chatId, replaced: hadPending });
      this.pendingMessage = { chatId, text, images, messageThreadId };
      await this.api.sendMessage(
        chatId,
        hadPending
          ? "⏳ Заменил предыдущее ожидающее сообщение. Приступлю, когда закончу текущее."
          : "⏳ Принял. Приступлю, когда закончу текущее."
      );
      return;
    }

    this.prepareFileConnection(chatId, messageThreadId);
    audit("turn.accepted", { chatId, chars: text.length, threadId: this.sessionId });
    this.isProcessing = true;
    this.activeDelivery = { chatId, cwd: this.projectPath, messageThreadId, controller: new AbortController() };
    this.toolCalls.clear();
    this.lastUsage = null;
    this.turnError = null;
    this.streamedByItem.clear();
    this.streamedThisTurn = "";
    this.finishedTurnIds.clear();
    this.appendChain = Promise.resolve();

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
      audit("turn.started", { threadId: this.sessionId, turnId: this.currentTurnId });
      if (this.currentTurnId && this.finishedTurnIds.has(this.currentTurnId)) {
        this.finishTurn?.();
      }

      this.armIdleWatchdog();
      await turnEnded;
      if (this.turnError) this.queueAppend(`\n\nError: ${this.turnError}`);
      statusLine = this.buildStatusLine();
    } catch (err: any) {
      this.queueAppend(`\n\nBridge error: ${err?.message || err}`);
    } finally {
      this.clearIdleWatchdog();
      this.finishTurn = null;
      // Drain queued appends before closing the message, or the tail is lost.
      audit("turn.finalizing", { threadId: this.sessionId, turnId: this.currentTurnId });
      try {
        await this.appendChain.catch(() => {});
        await streamer.finalize(statusLine);
      } catch (err) {
        audit("turn.delivery_failed", { errorType: (err as Error).name });
      }
      this.currentStreamer = null;
      audit("turn.finished", { threadId: this.sessionId, turnId: this.currentTurnId });
      this.currentTurnId = undefined;
      this.activeDelivery?.controller.abort();
      this.activeDelivery = null;
      this.isProcessing = false;
      for (const path of tempImages) await unlink(path).catch(() => {});

      const next = this.pendingMessage;
      if (next) {
        this.pendingMessage = null;
        this.sendMessage(next.chatId, next.text, next.images, next.messageThreadId).catch((err) => {
          console.error("Queued sendMessage error:", err);
        });
      }
    }
  }

  // ------------------------------------------------------------- internals

  private prepareFileConnection(chatId: number, messageThreadId?: number): void {
    if (this.scope) this.projectPath = this.scope.directory(this.projectPath);
    const bound = this.fileGatewayContext;
    if (!bound || (bound.chatId === chatId && bound.cwd === this.projectPath &&
        bound.messageThreadId === messageThreadId && this.openThread?.id === this.sessionId)) return;

    // A loaded thread retains its MCP process even when thread/resume receives
    // new configuration. Rotate the app-server before arming the next turn, so
    // returning to that thread cannot reuse its old gateway key. History stays
    // on disk and is resumed normally; previous destinations remain revoked.
    this.fileGatewayKey = "";
    this.fileGatewayContext = undefined;
    this.server.close();
    this.openThread = null;
  }

  private async ensureThread(): Promise<void> {
    if (this.scope) this.projectPath = this.scope.directory(this.projectPath);
    await this.server.start();

    // A thread already open in this app-server needs nothing: resuming it again
    // trips the "thread already has an active writer" conflict. The id must match
    // too — /switch swaps sessionId for a thread this process has never opened.
    if (
      this.sessionId &&
      this.openThread?.id === this.sessionId &&
      this.openThread.generation === this.server.generation
    ) {
      return;
    }

    const fileConfig: Record<string, any> = {};
    if (this.fileGateway) {
      this.fileGatewayKey = randomUUID();
      const active = this.activeDelivery;
      this.fileGatewayContext = active ? { chatId: active.chatId, cwd: active.cwd, messageThreadId: active.messageThreadId } : undefined;
      fileConfig["mcp_servers.vibecodex_files"] = {
        command: process.execPath,
        args: [fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
          fileURLToPath(new URL("../file-mcp.ts", import.meta.url))],
        env: { VIBECODEX_FILE_SOCKET: await this.fileGateway.start(), VIBECODEX_FILE_KEY: this.fileGatewayKey },
        startup_timeout_sec: 20, tool_timeout_sec: 150, enabled: true, required: true,
      };
    }

    if (this.sessionId) {
      try {
        if (this.scope) {
          const saved = await this.server.request("thread/read", { threadId: this.sessionId, includeTurns: false });
          if (this.scope.directory(saved?.thread?.cwd ?? "") !== this.projectPath) {
            throw new Error("Saved session belongs to another project");
          }
        }
        await this.server.request("thread/resume", {
          threadId: this.sessionId,
          cwd: this.projectPath,
          ...(this.scope ? { developerInstructions: FILE_DELIVERY_INSTRUCTIONS } : {}),
          ...(this.fileGateway ? { config: fileConfig } : {}),
        });
        this.openThread = { id: this.sessionId, generation: this.server.generation };
        return;
      } catch (err) {
        console.error(`Could not resume thread ${this.sessionId}, starting a new one:`, err);
        this.sessionId = undefined;
      }
    }

    const result = await this.server.request("thread/start", {
      cwd: this.projectPath,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
      ...(this.scope ? { developerInstructions: FILE_DELIVERY_INSTRUCTIONS,
        ...(this.fileGateway ? { config: fileConfig } : { dynamicTools: [SEND_FILE_TOOL] }) } : {}),
      ...(this.model ? { model: this.model } : {}),
    });
    this.sessionId = result?.thread?.id;
    if (!this.sessionId) throw new Error("app-server did not return a thread id");
    this.effectiveModel = result?.thread?.model ?? this.effectiveModel;
    this.effectiveEffort = result?.thread?.reasoningEffort ?? this.effectiveEffort;
    this.openThread = { id: this.sessionId, generation: this.server.generation };
    this.saveState();
  }

  private async writeTempImage(image: { data: string; mediaType: string }): Promise<string> {
    const extension = image.mediaType.split("/")[1] || "jpg";
    const path = join(tmpdir(), `vibeide-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
    await writeFile(path, Buffer.from(image.data, "base64"));
    return path;
  }

  private async handleToolCall(params: Record<string, any>): Promise<ToolResult> {
    const context = this.activeDelivery;
    if (params.tool !== "send_file" || params.namespace || !this.scope) return toolResult(false, "Unknown tool");
    if (!context || context.controller.signal.aborted || !this.isProcessing || !this.finishTurn ||
        !this.currentTurnId || params.threadId !== this.sessionId || params.turnId !== this.currentTurnId ||
        typeof params.callId !== "string" || !params.callId) {
      return toolResult(false, "File delivery is only available in the current active Telegram turn");
    }
    const key = `${params.threadId}:${params.turnId}:${params.callId}`;
    const previous = this.toolCalls.get(key);
    if (previous) return previous;
    const delivery = sendProjectFile(this.api, this.scope, context.chatId, context.cwd, params.arguments, context.controller.signal, context.messageThreadId)
      .then(sent => toolResult(true, JSON.stringify({ delivered: true, ...sent })))
      .catch((error: Error) => toolResult(false, error.message));
    this.toolCalls.set(key, delivery);
    return delivery;
  }

  private handleNotification({ method, params }: AppServerNotification): void {
    if (params.threadId && this.sessionId && params.threadId !== this.sessionId) {
      audit("codex.dropped_event", { method, threadId: params.threadId, expectedThreadId: this.sessionId });
      return;
    }
    if (this.idleTimer) this.armIdleWatchdog();
    const streamer = this.currentStreamer;
    // Deltas are intentionally excluded: log lifecycle and metadata, never content.
    if (method !== "item/agentMessage/delta") audit("codex.event", {
      method, threadId: params.threadId, turnId: params.turn?.id ?? params.turnId,
      itemId: params.item?.id, itemType: params.item?.type, status: params.turn?.status,
      willRetry: params.willRetry,
    });

    switch (method) {
      case "turn/started": {
        if (this.isProcessing && this.finishTurn) this.currentTurnId = params.turn?.id ?? params.turnId;
        return;
      }
      case "item/agentMessage/delta": {
        if (!streamer || !params.delta) return;
        const itemId: string = params.itemId ?? "";
        this.streamedByItem.set(itemId, (this.streamedByItem.get(itemId) ?? "") + params.delta);
        this.streamedThisTurn += params.delta;
        this.queueAppend(params.delta);
        return;
      }

      case "item/started": {
        if (!streamer || !this.options.toolNotices) return;
        const item = params.item ?? {};
        if (item.type === "commandExecution" && item.command) {
          this.queueAppend(`\n\n🔧 ${String(item.command).slice(0, 120)}\n`);
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
          if (tail) this.queueAppend(tail);
        } else if (!this.streamedThisTurn.includes(full)) {
          // Deltas and the final item disagree, and this text is genuinely new.
          this.queueAppend(full);
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
        this.turnError = params.error?.message ?? "unknown error";
        // willRetry means Codex handles it internally and keeps streaming;
        // finishing here would finalize the message and lose the retried output.
        if (!params.willRetry) this.finishTurn?.();
        return;
      }

      case "turn/completed": {
        const status: string | undefined = params.turn?.status;
        if (status === "failed") {
          this.turnError = params.turn?.error?.message ?? "turn failed";
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
      audit("turn.idle_timeout", { threadId: this.sessionId, turnId: this.currentTurnId });
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
