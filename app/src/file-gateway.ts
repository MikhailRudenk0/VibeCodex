import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./state.js";
import { toolResult, type ToolResult } from "./send-file.js";

/** Private local transport; all file access and Telegram routing stay in the bot. */
export class FileGateway {
  private server?: Server;
  private directory?: string;
  private starting?: Promise<string>;

  constructor(private readonly deliver: (input: Record<string, any>) => Promise<ToolResult>) {}

  start(): Promise<string> {
    return this.starting ??= this.listen();
  }

  private async listen(): Promise<string> {
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(join(stateDir(), "file-tools-"));
    const path = join(this.directory, "send.sock");
    this.server = createServer(async (req, res) => {
      const respond = (result: ToolResult) => {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        }
      };
      if (req.method !== "POST" || req.url !== "/send-file") {
        res.writeHead(404); res.end(); return;
      }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) throw new Error("Request too large");
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (!input || typeof input !== "object" || typeof input.key !== "string" ||
            typeof input.requestId !== "string" || input.requestId.length > 128) throw new Error("Invalid request");
        respond(await this.deliver(input));
      } catch {
        respond(toolResult(false, "File request failed; delivery was not confirmed. Do not automatically retry."));
      }
    });
    this.server.requestTimeout = 130_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, resolve);
    });
    await chmod(path, 0o600);
    return path;
  }

  async close(): Promise<void> {
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(r => this.server!.close(() => r())); }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.server = undefined; this.directory = undefined; this.starting = undefined;
  }
}
