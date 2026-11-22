import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBridge } from "../app/src/codex/bridge.js";

const root = await mkdtemp(join(tmpdir(), "vibe-file-switch-"));
process.env.VIBEIDE_STATE_DIR = join(root, "state");
const first = join(root, "first"), second = join(root, "second");
await mkdir(first); await mkdir(second);
await writeFile(join(first, "report.txt"), "first project");
await writeFile(join(second, "report.txt"), "second project");
const uploads: any[] = [], deliveries: any[] = [];
let message = 0, turns = 0, closes = 0, generation = 1;
const api: any = {
  async sendMessage() { return { message_id: ++message }; },
  async editMessageText() { return true; },
  async sendDocument(...args: any[]) { uploads.push(args); return { message_id: ++message }; },
};
const bridge: any = new CodexBridge(api, first, { allowedProjectRoot: root, fileDeliveryMcp: true });
const saved = new Map<string, any>(), loaded = new Map<string, any>();
const deadline = setTimeout(() => { console.error("FAIL: switching test timeout"); process.exit(1); }, 15_000);

function callGateway(env: any, requestId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: env.VIBECODEX_FILE_SOCKET, path: "/send-file", method: "POST" }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ key: env.VIBECODEX_FILE_KEY, requestId, arguments: { path: "report.txt" } }));
  });
}

// Like the observed app-server, a loaded thread keeps its initial MCP process:
// thread/resume does not replace that process's environment. Restarting the
// server unloads it, while the saved conversation remains available.
bridge.server = {
  get generation() { return generation; },
  async start() {},
  close() { closes++; generation++; loaded.clear(); },
  async request(method: string, params: any) {
    if (method === "thread/start") {
      const id = `thread-${saved.size}`;
      saved.set(id, { id, cwd: params.cwd, turns: [] });
      loaded.set(id, params.config["mcp_servers.vibecodex_files"].env);
      return { thread: saved.get(id) };
    }
    if (method === "thread/read") return { thread: saved.get(params.threadId) };
    if (method === "thread/resume") {
      if (!loaded.has(params.threadId)) loaded.set(params.threadId, params.config["mcp_servers.vibecodex_files"].env);
      return { thread: saved.get(params.threadId) };
    }
    assert.equal(method, "turn/start");
    const id = `turn-${++turns}`, threadId = params.threadId;
    setTimeout(async () => {
      try {
        const result = await callGateway(loaded.get(threadId), id);
        deliveries.push(result);
        const turn = { id, status: "completed", items: [] };
        saved.get(threadId).turns = [turn];
        bridge.handleNotification({ method: "turn/completed", params: { threadId, turn } });
      } catch (error) {
        console.error(error); bridge.finishTurn?.();
      }
    }, 0);
    return { turn: { id } };
  },
};

try {
  await bridge.sendMessage(123, "send report", undefined, 7);
  const firstId = bridge.sessionId;
  await bridge.sendMessage(123, "send again", undefined, 7);
  assert.equal(closes, 0, "same conversation reuses the connection");

  bridge.projectPath = second; bridge.sessionId = undefined;
  await bridge.sendMessage(123, "send second project", undefined, 7);
  const secondId = bridge.sessionId;
  bridge.projectPath = first; bridge.sessionId = firstId;
  await bridge.sendMessage(123, "return to first", undefined, 7);
  assert.equal(bridge.sessionId, firstId, "return preserves history");
  assert.equal(closes, 2, "each project transition unloads cached MCP processes");

  bridge.sessionId = undefined;
  await bridge.sendMessage(123, "new conversation, same project", undefined, 7);
  assert.notEqual(bridge.sessionId, firstId);
  assert.equal(closes, 3, "a new conversation also revokes the previous connection");
  await bridge.sendMessage(123, "new Telegram topic", undefined, 8);
  assert.equal(closes, 4);
  await bridge.sendMessage(456, "new Telegram chat", undefined, 8);
  assert.equal(closes, 5);

  bridge.projectPath = second; bridge.sessionId = secondId;
  await bridge.sendMessage(456, "return to second", undefined, 8);
  assert.equal(bridge.sessionId, secondId);
  assert.equal(closes, 6);
  assert.equal(deliveries.length, 8);
  assert(deliveries.every(d => d.success), "all transitions must retain delivery");
  assert.equal(uploads.length, 8);
  assert.deepEqual(uploads.map(u => [u[0], u[2].message_thread_id]), [
    [123, 7], [123, 7], [123, 7], [123, 7], [123, 7], [123, 8], [456, 8], [456, 8],
  ]);
  assert.equal(bridge.activeDelivery, null, "delivery scope is cleared after the turn");
  console.log("PASS: 8 file sends across project returns, new conversations, chats and topics; history preserved; same destination reused");
} finally {
  clearTimeout(deadline);
  await bridge.fileGateway.close(); bridge.close();
  await rm(root, { recursive: true, force: true });
}
