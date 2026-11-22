import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectScope } from "../app/src/project-scope.js";
import { readProjectFile, sendProjectFile, SEND_FILE_TOOL } from "../app/src/send-file.js";
import { CodexBridge } from "../app/src/codex/bridge.js";

const dir = await mkdtemp(join(tmpdir(), "vibe-files-"));
process.env.VIBEIDE_STATE_DIR = join(dir, "state");
const root = join(dir, "group");
const project = join(root, "project");
const other = join(dir, "group-other");
await mkdir(project, { recursive: true });
await mkdir(other);
await writeFile(join(project, "report.txt"), "requested report");
await writeFile(join(other, "private.txt"), "other group");
const scope = new ProjectScope(root);
const uploads: any[] = [];
const api = { async sendDocument(...args: any[]) { uploads.push(args); return { message_id: 42 }; } } as any;

try {
  assert.equal((await readProjectFile(scope, project, "report.txt")).bytes.toString(), "requested report");
  for (const path of ["../../group-other/private.txt", join(other, "private.txt")]) {
    await assert.rejects(readProjectFile(scope, project, path), /outside/);
  }
  await symlink(join(other, "private.txt"), join(project, "escape.txt"));
  await symlink(other, join(project, "escape-dir"));
  await assert.rejects(readProjectFile(scope, project, "escape.txt"), /outside/);
  await assert.rejects(readProjectFile(scope, project, "escape-dir/private.txt"), /outside/);
  assert.equal(scope.allowsDirectory(join(project, "escape-dir")), false);
  await link(join(other, "private.txt"), join(project, "hardlink.txt"));
  await assert.rejects(readProjectFile(scope, project, "hardlink.txt"), /Hard-linked/);
  await assert.rejects(readProjectFile(scope, project, "."), /regular files/);
  await assert.rejects(readProjectFile(scope, project, "report.txt", 3), /upload limit/);
  await assert.rejects(sendProjectFile(api, scope, 7, project, { path: "report.txt", chatId: 999 }), /recipient is fixed/);
  await assert.rejects(sendProjectFile(api, scope, 7, project, { path: "report.txt", caption: "x".repeat(1025) }), /caption/);
  assert.equal(uploads.length, 0);
  assert.deepEqual(await sendProjectFile(api, scope, 7, project, { path: "report.txt", caption: "Report" }), {
    messageId: 42, filename: "report.txt", size: 16,
  });
  assert.equal(uploads[0][0], 7);
  assert.equal(uploads[0][2].caption, "Report");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(sendProjectFile(api, scope, 7, project, { path: "report.txt" }, abort.signal));
  assert.equal(uploads.length, 1);

  const bridge: any = new CodexBridge(api, project, { allowedProjectRoot: root });
  bridge.sessionId = "thread";
  bridge.currentTurnId = "turn";
  bridge.isProcessing = true;
  bridge.finishTurn = () => {};
  bridge.activeDelivery = { chatId: 17, cwd: project, controller: new AbortController() };
  const call = { threadId: "thread", turnId: "turn", callId: "call", tool: "send_file", arguments: { path: "report.txt" } };
  const [a, b] = await Promise.all([bridge.handleToolCall(call), bridge.handleToolCall(call)]);
  assert.equal(a.success, true);
  assert.deepEqual(a, b);
  assert.equal(uploads.length, 2, "duplicate call IDs upload only once");
  assert.equal(uploads[1][0], 17, "tool is bound to the active chat");
  assert.equal((await bridge.handleToolCall({ ...call, turnId: "old" })).success, false);
  assert.equal((await bridge.handleToolCall({ ...call, threadId: "other" })).success, false);
  assert.equal((await bridge.handleToolCall({ ...call, tool: "anything_else" })).success, false);
  assert.equal((await bridge.handleToolCall({ ...call, callId: "bad", arguments: { path: "../../group-other/private.txt" } })).success, false);
  bridge.activeDelivery.controller.abort();
  assert.equal((await bridge.handleToolCall({ ...call, callId: "late" })).success, false);
  assert.equal(uploads.length, 2);

  const failing: any = new CodexBridge({ async sendDocument() { throw new Error("network"); } } as any, project, { allowedProjectRoot: root });
  Object.assign(failing, { sessionId: "thread", currentTurnId: "turn", isProcessing: true, finishTurn() {},
    activeDelivery: { chatId: 17, cwd: project, controller: new AbortController() } });
  const failure = await failing.handleToolCall(call);
  assert.equal(failure.success, false);
  assert.match(failure.contentItems[0].text, /could not be confirmed/);

  // The tool is advertised in new threads, and stale saved sessions cannot escape the group.
  const requests: any[] = [];
  const fresh: any = new CodexBridge(api, project, { allowedProjectRoot: root });
  fresh.sessionId = "outside";
  fresh.server = { generation: 1, async start() {}, async request(method: string, params: any) {
    requests.push({ method, params });
    if (method === "thread/read") return { thread: { cwd: other } };
    return { thread: { id: "new" } };
  } };
  await fresh.ensureThread();
  assert.equal(fresh.sessionId, "new");
  assert(!requests.some(r => r.method === "thread/resume"));
  assert.deepEqual(requests.find(r => r.method === "thread/start").params.dynamicTools, [SEND_FILE_TOOL]);
  fresh.server.request = async () => ({ data: [{ id: "a", cwd: other }, { id: "b", cwd: project }] });
  assert.deepEqual((await fresh.listProjects()).map((p: any) => p.path), [project]);
  const alias = join(root, "old-project-path");
  await symlink(project, alias);
  fresh.server.request = async () => ({ data: [{ id: "preserved", cwd: alias, updatedAt: 10 }] });
  assert.deepEqual((await fresh.listProjects()).map((p: any) => p.path), [project]);
  assert.equal(await fresh.resumeLatestSession(), "preserved", "directory aliases retain existing conversations");
  // Let the asynchronous state writer finish before removing its directory.
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log("PASS: file boundaries, fixed recipient, deduplication, cancellation, upload errors, tool registration, and session isolation");
} finally { await rm(dir, { recursive: true, force: true }); }
