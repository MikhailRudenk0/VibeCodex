/** Integration check: an existing thread gains file delivery on resume.
 * Uses the real installed Codex and a fake Telegram API; sends no chat messages.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppServer } from "../app/src/codex/app-server.js";
import { CodexBridge } from "../app/src/codex/bridge.js";

const dir = await mkdtemp(join(tmpdir(), "file-mcp-live-"));
process.env.VIBEIDE_STATE_DIR = join(dir, "state");
await writeFile(join(dir, "report.txt"), "File delivery integration check\n");
let finish!: (result: any) => void;
const ended = new Promise<any>(resolve => { finish = resolve; });
const baseline = new AppServer(n => {
  if (n.method === "turn/completed") finish(n.params.turn);
}, () => {});
const uploads: any[] = [];
let message = 0;
const api: any = {
  async sendMessage() { return { message_id: ++message }; },
  async editMessageText() { return true; },
  async sendChatAction() { return true; },
  async sendDocument(...args: any[]) { uploads.push(args); return { message_id: ++message }; },
};
const bridge: any = new CodexBridge(api, dir, { allowedProjectRoot: dir, fileDeliveryMcp: true });
let threadId: string | undefined;
const deadline = setTimeout(() => { console.error("FAIL: integration timeout"); process.exit(1); }, 150_000);
try {
  const initial = await baseline.request("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
  threadId = initial.thread.id;
  await baseline.request("turn/start", { threadId, input: [{ type: "text", text: "Test setup: reply only READY. Do not use tools or change files." }] });
  assert.equal((await ended).status, "completed");
  baseline.close();
  await new Promise(r => setTimeout(r, 500));
  bridge.sessionId = threadId;
  await bridge.sendMessage(-900001, "Send the existing report.txt to me using the send_file tool exactly once. This is an integration test with a fake Telegram adapter. Do not use shell commands or change files. Reply briefly after the tool succeeds.", undefined, 44);
  assert.equal(bridge.sessionId, threadId, "existing conversation must be resumed");
  assert.equal(uploads.length, 1, "real model must call the file tool once");
  assert.equal(uploads[0][0], -900001, "destination is the originating chat");
  assert.equal(uploads[0][2].message_thread_id, 44, "topic is preserved");
  assert.equal(uploads[0][1].filename, "report.txt");
  const status = await bridge.server.request("mcpServerStatus/list", { threadId, serverName: "vibecodex_files" });
  assert(status.data.some((s: any) => s.name === "vibecodex_files" && s.tools?.send_file), "MCP tool is registered on the resumed thread");
  const idle = await bridge.server.request("mcpServer/tool/call", { threadId, server: "vibecodex_files", tool: "send_file", arguments: { path: "report.txt" } });
  assert.equal(idle.isError, true, "idle calls cannot deliver files");
  assert.equal(uploads.length, 1);
  console.log("PASS: real Codex resumes an existing thread, invokes MCP send_file, preserves group topic, and refuses idle sends; Telegram was mocked");
} finally {
  clearTimeout(deadline);
  if (threadId) await bridge.server.request("thread/archive", { threadId }).catch(() => {});
  baseline.close(); bridge.close();
  await new Promise(r => setTimeout(r, 100));
  await rm(dir, { recursive: true, force: true });
}
