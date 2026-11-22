import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexBridge } from "../app/src/codex/bridge.js";

const dir = await mkdtemp(join(tmpdir(), "file-gateway-"));
process.env.VIBEIDE_STATE_DIR = join(dir, "state");
await writeFile(join(dir, "report.txt"), "report");
const uploads: any[] = [];
const bridge: any = new CodexBridge({ async sendDocument(...args: any[]) {
  uploads.push(args); return { message_id: 1 };
} } as any, dir, { allowedProjectRoot: dir, fileDeliveryMcp: true });
Object.assign(bridge, { sessionId: "thread", currentTurnId: "turn", isProcessing: true, finishTurn() {},
  fileGatewayKey: "connection-one", fileGatewayContext: { chatId: 123, cwd: dir, messageThreadId: 7 },
  activeDelivery: { chatId: 123, cwd: dir, messageThreadId: 7, controller: new AbortController() } });
const socketPath = await bridge.fileGateway.start();
const call = (input: any): Promise<any> => new Promise((resolve, reject) => {
  const req = request({ socketPath, path: "/send-file", method: "POST" }, res => {
    let data = ""; res.on("data", chunk => data += chunk); res.on("end", () => resolve(JSON.parse(data)));
  });
  req.on("error", reject); req.end(JSON.stringify(input));
});
try {
  const input = { key: "connection-one", requestId: "one", arguments: { path: "report.txt" } };
  assert.equal((await call({ ...input, key: "old" })).success, false);
  const [a, b] = await Promise.all([call(input), call(input)]);
  assert(a.success); assert.deepEqual(a, b); assert.equal(uploads.length, 1);
  assert.equal(uploads[0][0], 123); assert.equal(uploads[0][2].message_thread_id, 7);
  bridge.activeDelivery.chatId = 999;
  assert.equal((await call({ ...input, requestId: "two" })).success, false);
  bridge.activeDelivery.chatId = 123; bridge.activeDelivery.messageThreadId = 8;
  assert.equal((await call({ ...input, requestId: "three" })).success, false);
  bridge.activeDelivery.messageThreadId = 7; bridge.activeDelivery.controller.abort();
  assert.equal((await call({ ...input, requestId: "four" })).success, false);
  assert.equal(uploads.length, 1);
  console.log("PASS: private gateway rejects stale connections, cross-chat/topic calls and cancellation; duplicates upload once");
} finally { await bridge.fileGateway.close(); bridge.close(); await rm(dir, { recursive: true, force: true }); }
