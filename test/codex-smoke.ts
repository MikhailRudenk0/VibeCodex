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
// Must be set before the bridge module reads it at import time.
process.env.VIBEIDE_STATE_DIR =
  process.env.VIBEIDE_STATE_DIR || join(tmpdir(), "vibeide-smoke-state");

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

  // ---- 5. queueing while busy -----------------------------------------
  console.log("\n5. очередь при занятости");
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
  await rm(process.env.VIBEIDE_STATE_DIR!, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОШЛИ" : `ПРОВАЛЕНО: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
