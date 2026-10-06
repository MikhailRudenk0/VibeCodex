/**
 * End-to-end smoke test for the Codex bridge against a real `codex app-server`.
 * Telegram is faked: every sendMessage/editMessageText is recorded so we can
 * assert that text actually streamed in rather than landing in one lump.
 *
 * Run: npx tsx test/codex-smoke.ts
 */
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
// Must be set before the bridge module reads it at import time. The test always
// uses its own directory: honouring an inherited one would mean deleting a
// directory the developer chose, possibly the live state.
const stateDir = await mkdtemp(join(tmpdir(), "vibeide-smoke-state-"));
process.env.VIBEIDE_STATE_DIR = stateDir;

const { CodexBridge } = await import("../app/src/codex/bridge.js");

interface Call { kind: "send" | "edit"; messageId: number; text: string; at: number }

const calls: Call[] = [];
let nextMessageId = 1;

const fakeApi = {
  async sendMessage(_chatId: number, text: string) {
    const message_id = nextMessageId++;
    calls.push({ kind: "send", messageId: message_id, text, at: Date.now() });
    return { message_id };
  },
  async editMessageText(_chatId: number, messageId: number, text: string) {
    calls.push({ kind: "edit", messageId, text, at: Date.now() });
    return true;
  },
} as any;

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  const mark = condition ? "✓" : "✗";
  if (!condition) failures++;
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const workdir = await mkdtemp(join(tmpdir(), "vibeide-smoke-"));
  await writeFile(join(workdir, "hello.txt"), "codex smoke test marker 4711\n");
  console.log(`workdir: ${workdir}\n`);

  const bridge = new CodexBridge(fakeApi, workdir, {
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  bridge.effort = "low";

  // ---- 1. models -------------------------------------------------------
  console.log("1. model/list");
  const models = await bridge.getSupportedModels();
  check("модели получены", models.length > 0, `${models.length}: ${models.map((m) => m.value).join(", ")}`);

  // ---- 2. streamed answer ---------------------------------------------
  console.log("\n2. потоковый ответ");
  calls.length = 0;
  const started = Date.now();
  await bridge.sendMessage(1, "Напиши ровно три коротких абзаца про то, зачем нужен SSH-туннель. Без кода, без списков.");
  const edits = calls.filter((c) => c.kind === "edit");
  const final = edits.at(-1)?.text ?? calls.at(-1)?.text ?? "";

  check("сессия заведена", Boolean(bridge.sessionId), bridge.sessionId);
  check("ответ непустой", final.length > 200, `${final.length} символов`);
  check("стриминг шёл частями", edits.length >= 3, `${edits.length} правок сообщения`);
  check("ровно одно сообщение в чат", new Set(calls.map((c) => c.messageId)).size === 1);
  check("статус-строка добавлена", /`.+↓.+↑`/.test(final), final.slice(-60).replace(/\n/g, " "));
  check("индикатор прогресса убран", !final.includes("in progress"));

  const growth = edits.map((e) => e.text.length);
  const monotonic = growth.every((len, i) => i === 0 || len >= growth[i - 1]);
  check("текст нарастал монотонно", monotonic, growth.slice(0, 6).join(" → ") + " …");
  console.log(`  время: ${((Date.now() - started) / 1000).toFixed(1)} с`);
  console.log(`\n  --- хвост ответа ---\n  ${final.slice(-220).replace(/\n/g, "\n  ")}\n`);

  // ---- 3. tool use + session continuity --------------------------------
  console.log("3. инструменты и продолжение сессии");
  const firstSession = bridge.sessionId;
  calls.length = 0;
  await bridge.sendMessage(1, "Прочитай файл hello.txt в текущем каталоге и напиши ТОЛЬКО число, которое в нём есть.");
  const second = (calls.filter((c) => c.kind === "edit").at(-1)?.text ?? calls.at(-1)?.text ?? "");
  check("команда выполнена, число найдено", second.includes("4711"), second.replace(/\n/g, " ").slice(0, 200));
  check("сессия та же", bridge.sessionId === firstSession, bridge.sessionId);

  // ---- 4. projects -----------------------------------------------------
  console.log("\n4. список проектов");
  const projects = await bridge.listProjects();
  check("проекты получены", projects.length > 0, `${projects.length} шт.`);
  check("текущий каталог в списке", projects.some((p) => p.path === workdir));

  // ---- 5. switching projects mid-session -------------------------------
  // Regression: tracking only the app-server generation made ensureThread skip
  // the open step after /switch, and every later turn failed with "thread not found".
  console.log("\n5. переключение проекта");
  const other = await mkdtemp(join(tmpdir(), "vibeide-smoke2-"));
  await writeFile(join(other, "other.txt"), "second marker 9182\n");
  bridge.projectPath = other;
  await bridge.resumeLatestSession();
  calls.length = 0;
  await bridge.sendMessage(1, "Прочитай other.txt в текущем каталоге и напиши ТОЛЬКО число из него.");
  const afterSwitch = calls.filter((c) => c.kind === "edit").at(-1)?.text ?? calls.at(-1)?.text ?? "";
  check("после /switch ход проходит", afterSwitch.includes("9182"), afterSwitch.replace(/\n/g, " ").slice(0, 120));
  check("нет ошибки thread not found", !/thread not found/i.test(afterSwitch));
  await rm(other, { recursive: true, force: true });

  // ---- 6. effort levels come from the backend --------------------------
  console.log("\n6. уровни усилий");
  const efforts = await bridge.getSupportedEfforts();
  check("уровни получены", efforts.length > 0, efforts.join(", "));
  check("нет несуществующего minimal", !efforts.includes("minimal"));

  // ---- 7. queueing while busy -----------------------------------------
  console.log("\n7. очередь при занятости");
  calls.length = 0;
  const slow = bridge.sendMessage(1, "Посчитай от 1 до 20 словами, по одному слову в строке.");
  await new Promise((r) => setTimeout(r, 600));
  await bridge.sendMessage(1, "второе сообщение");
  const queued = calls.some((c) => c.text.includes("Принял"));
  check("второе сообщение поставлено в очередь", queued);
  await slow;
  await new Promise((r) => setTimeout(r, 1500));

  bridge.close();
  await rm(workdir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОШЛИ" : `ПРОВАЛЕНО: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
