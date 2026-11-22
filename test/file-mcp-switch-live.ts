/** Real app-server regression: revisit a persisted project after switching away.
 * One minimal model turn persists the conversation. Telegram is mocked.
 * Run explicitly: node_modules/.bin/tsx test/file-mcp-switch-live.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBridge } from "../app/src/codex/bridge.js";

const root = await mkdtemp(join(tmpdir(), "vibe-mcp-return-"));
process.env.VIBEIDE_STATE_DIR = join(root, "state");
const first = join(root, "first"), second = join(root, "second");
await mkdir(first); await mkdir(second);
await writeFile(join(first, "report.txt"), "first project");
await writeFile(join(second, "report.txt"), "second project");
const uploads: any[] = [];
const bridge: any = new CodexBridge({ async sendDocument(...args: any[]) {
  uploads.push(args); return { message_id: uploads.length };
} } as any, first, { allowedProjectRoot: root, fileDeliveryMcp: true });
const ids: string[] = [];
const timeout = setTimeout(() => { console.error("Probe timeout"); process.exit(1); }, 150_000);
async function enter(cwd: string, thread?: string) {
  bridge.projectPath = cwd; bridge.sessionId = thread;
  bridge.prepareFileConnection(-900001, 44);
  bridge.activeDelivery = { chatId: -900001, cwd, messageThreadId: 44, controller: new AbortController() };
  bridge.isProcessing = true; bridge.finishTurn = () => {};
  bridge.currentTurnId = `mock-turn-${uploads.length}`;
  await bridge.ensureThread();
  if (!ids.includes(bridge.sessionId)) ids.push(bridge.sessionId);
  const status = await bridge.server.request("mcpServerStatus/list", { threadId: bridge.sessionId });
  assert(status.data.some((s: any) => s.name === "vibecodex_files" && s.tools?.send_file));
  return bridge.server.request("mcpServer/tool/call", { threadId: bridge.sessionId,
    server: "vibecodex_files", tool: "send_file", arguments: { path: "report.txt" } });
}
try {
  const a = await enter(first); const firstId = bridge.sessionId;
  console.log("first visit", a); assert.equal(a.isError, false);
  const notify = bridge.server.onNotification;
  let finish!: (turn: any) => void;
  const persisted = new Promise<any>(resolve => { finish = resolve; });
  bridge.server.onNotification = (event: any) => {
    notify(event);
    if (event.method === "turn/completed" && event.params.threadId === firstId) finish(event.params.turn);
  };
  await bridge.server.request("turn/start", { threadId: firstId,
    input: [{ type: "text", text: "Reply only READY. Do not use tools or change files." }],
    approvalPolicy: "never", cwd: first });
  assert.equal((await persisted).status, "completed");
  const b = await enter(second);
  console.log("second project", b); assert.equal(b.isError, false);
  const returned = await enter(first, firstId);
  console.log("return to first", returned);
  assert.equal(bridge.sessionId, firstId, "the saved conversation must be retained");
  assert.equal(returned.isError, false, "returning to a previously opened project must preserve file delivery");
  assert.equal(uploads.length, 3);
  console.log("PASS: A → B → A delivered once per request; one minimal persistence turn, no Telegram requests");
} finally {
  clearTimeout(timeout);
  for (const threadId of ids) await bridge.server.request("thread/archive", { threadId }).catch(() => {});
  bridge.close();
  await new Promise(r => setTimeout(r, 200));
  await rm(root, { recursive: true, force: true });
}
