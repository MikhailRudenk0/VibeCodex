import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface, type Interface } from "readline";

export interface AppServerNotification {
  method: string;
  params: Record<string, any>;
}

export class AppServerError extends Error {}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppServerOptions {
  /** Binary to run; defaults to `codex` from PATH. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /**
   * Called when the subprocess goes away. In-flight requests reject on their own,
   * but anything waiting on notifications (a running turn) would hang forever
   * without this.
   */
  onDisconnect?: (error: Error) => void;
}

/**
 * Persistent JSON-RPC client for `codex app-server`.
 *
 * The CLI speaks newline-delimited JSON over stdio: requests carry an `id` and
 * get exactly one response, notifications carry only a `method`. Everything the
 * agent produces mid-turn — streamed text, tool starts, token usage — arrives as
 * notifications, which is why this exists instead of `@openai/codex-sdk`: the SDK
 * only surfaces whole messages.
 */
export class AppServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private starting: Promise<void> | null = null;
  private spawnCount = 0;
  private readonly timeoutMs: number;

  constructor(
    private readonly onNotification: (notification: AppServerNotification) => void,
    private readonly log: (message: string) => void,
    private readonly options: AppServerOptions = {}
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  /** Increments on every spawn, so callers can tell a restarted server from the old one. */
  get generation(): number {
    return this.spawnCount;
  }

  /** Spawns and initializes the server if needed. Concurrent callers share one attempt. */
  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.spawnAndInitialize().catch((err) => {
        this.starting = null;
        this.teardown(err instanceof Error ? err : new Error(String(err)));
        throw err;
      });
    }
    return this.starting;
  }

  async request(method: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<any> {
    await this.start();
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) {
      throw new AppServerError("app-server is not running");
    }

    return this.dispatch(method, params, timeoutMs ?? this.timeoutMs);
  }

  notify(method: string, params?: Record<string, any>): void {
    const message: Record<string, any> = { method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  close(): void {
    const proc = this.proc;
    this.teardown(new AppServerError("app-server was closed"));
    if (proc && proc.exitCode === null) proc.kill();
  }

  private async spawnAndInitialize(): Promise<void> {
    const command = this.options.command ?? "codex";
    this.spawnCount++;
    const proc = spawn(command, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    this.reader = createInterface({ input: proc.stdout });
    this.reader.on("line", (line) => {
      // Stale readers from a previous process must not touch current state.
      if (proc !== this.proc) return;
      this.handleLine(line);
    });

    proc.stderr.on("data", (chunk: string) => {
      const text = chunk.trimEnd();
      if (text) this.log(`app-server: ${text}`);
    });

    proc.on("error", (err) => {
      if (proc !== this.proc) return;
      this.starting = null;
      this.teardown(new AppServerError(`failed to spawn ${command}: ${err.message}`));
    });

    proc.on("exit", (code, signal) => {
      if (proc !== this.proc) return;
      this.starting = null;
      this.teardown(new AppServerError(`app-server exited (code ${code ?? signal})`));
    });

    // The handshake itself cannot go through request(): start() has not resolved yet.
    await this.dispatch(
      "initialize",
      {
        clientInfo: { name: "vibeide", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      },
      this.timeoutMs
    );
    this.notify("initialized");
  }

  /**
   * Sends one request and waits for its response. The pending entry is removed
   * again if the write itself fails, so a failed send cannot leave a promise
   * that rejects later with nobody listening.
   */
  private dispatch(method: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    let settle!: { resolve: (value: any) => void; reject: (error: Error) => void };
    const response = new Promise<any>((resolve, reject) => {
      settle = { resolve, reject };
    });

    const timer = setTimeout(() => {
      this.pending.delete(id);
      settle.reject(new AppServerError(`app-server request timed out: ${method}`));
    }, timeoutMs);
    this.pending.set(id, { ...settle, timer });

    try {
      this.write({ id, method, params });
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw err;
    }
    return response;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: any;
    try {
      message = JSON.parse(line);
    } catch (err) {
      this.log(`app-server sent invalid JSON: ${String(err)}`);
      return;
    }

    const hasResult = "result" in message || "error" in message;
    if (message.id !== undefined && message.id !== null && hasResult) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const detail = message.error?.message ?? JSON.stringify(message.error);
        entry.reject(new AppServerError(detail));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined && message.id !== null) {
      // Server asks us something. We run with approvals disabled, so anything
      // arriving here is unexpected — decline rather than hang the turn.
      this.log(`declining app-server request: ${message.method}`);
      this.write({ id: message.id, result: { decision: "decline" } });
      return;
    }

    if (message.method) {
      try {
        this.onNotification({ method: message.method, params: message.params ?? {} });
      } catch (err) {
        this.log(`notification handler failed: ${String(err)}`);
      }
    }
  }

  private write(message: Record<string, any>): void {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.stdin.writable) {
      throw new AppServerError("app-server is not running");
    }
    proc.stdin.write(JSON.stringify(message) + "\n");
  }

  private teardown(error: Error): void {
    const wasRunning = this.proc !== null;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.reader?.close();
    this.reader = null;
    this.proc = null;
    this.starting = null;
    if (wasRunning) this.options.onDisconnect?.(error);
  }
}
