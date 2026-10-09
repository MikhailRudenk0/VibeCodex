/**
 * Проверки файла настроек.
 *
 * Главное здесь — что токен и рабочий каталог нельзя развести по разным инстансам:
 * раньше токен приходил из своего .env, а каталог задавался отдельным аргументом
 * командной строки, и перепутать их было легко.
 *
 * Run: npx tsx test/config.ts
 */
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const work = await mkdtemp(join(tmpdir(), "vibecodex-config-"));
const alpha = join(work, "alpha");
const beta = join(work, "beta");
await mkdir(alpha);
await mkdir(beta);

const configPath = join(work, "vibecodex.yaml");
process.env.VIBECODEX_CONFIG = configPath;

await writeFile(configPath, `
instances:
  alpha:
    bot:
      token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      username: AlphaBot
      allowedUserIds: [111, 222]
    projectPath: ${alpha}
    codex:
      sandboxMode: workspace-write
  beta:
    bot:
      token: "222222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      username: "@BetaBot"
      allowedUserIds: 333
    projectPath: ${beta}
    provider: claude
`);

const { loadConfig, listInstances } = await import("../app/src/config.js");
const { setInstanceId, stateFile } = await import("../app/src/state.js");
process.env.VIBEIDE_STATE_DIR = work;

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function expectThrow(name: string, fn: () => unknown, expectText: string) {
  try {
    fn();
    check(name, false, "ошибки не было");
  } catch (err: any) {
    const message = String(err?.message ?? err);
    check(name, message.includes(expectText), message.slice(0, 90));
  }
}

console.log("1. инстанс выбирает токен и каталог одним куском");
const a = loadConfig("alpha");
const b = loadConfig("beta");
check("токены разные", a.telegramBotToken !== b.telegramBotToken);
check("каталоги разные", a.projectPath !== b.projectPath);
check("alpha → свой каталог", a.projectPath === alpha, a.projectPath);
check("beta → свой каталог", b.projectPath === beta, b.projectPath);
check("имя бота распознано", a.expectedUsername === "AlphaBot", a.expectedUsername);
check("собачка в имени отброшена", b.expectedUsername === "BetaBot", b.expectedUsername);

console.log("\n2. значения приводятся к нужному виду");
check("один id становится списком", JSON.stringify(b.allowedUserIds) === "[333]");
check("список id сохранён", JSON.stringify(a.allowedUserIds) === "[111,222]");
check("sandboxMode прочитан", a.codex.sandboxMode === "workspace-write", a.codex.sandboxMode);
check("sandboxMode по умолчанию", b.codex.sandboxMode === "danger-full-access", b.codex.sandboxMode);
check("provider по умолчанию codex", a.provider === "codex");
check("provider можно переопределить", b.provider === "claude");
check("toolNotices выключен по умолчанию", a.codex.toolNotices === false);

console.log("\n3. состояние не делится между инстансами");
setInstanceId("alpha");
const stateA = stateFile("state-codex");
setInstanceId("beta");
const stateB = stateFile("state-codex");
check("файлы состояния разные", stateA !== stateB);
check("имя инстанса в имени файла", stateA.endsWith("state-codex-alpha.json"), stateA);

console.log("\n4. ошибки в настройках видны сразу");
expectThrow("неизвестный инстанс называет доступные", () => loadConfig("gamma"), "alpha, beta");
check("listInstances перечисляет оба", JSON.stringify(listInstances()) === '["alpha","beta"]');

const broken = join(work, "broken.yaml");
process.env.VIBECODEX_CONFIG = broken;
await writeFile(broken, `
instances:
  bad-token:
    bot: { token: "не-токен", allowedUserIds: [1] }
    projectPath: ${alpha}
  no-users:
    bot: { token: "333333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }
    projectPath: ${alpha}
  gone:
    bot: { token: "444444444:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", allowedUserIds: [1] }
    projectPath: ${join(work, "нет-такого")}
  relative:
    bot: { token: "555555555:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", allowedUserIds: [1] }
    projectPath: ./относительный
`);
expectThrow("кривой токен отвергнут", () => loadConfig("bad-token"), "не похож на токен");
expectThrow("пустой список пользователей отвергнут", () => loadConfig("no-users"), "allowedUserIds");
expectThrow("несуществующий каталог отвергнут", () => loadConfig("gone"), "не существует");
expectThrow("относительный путь отвергнут", () => loadConfig("relative"), "абсолютным");

await rm(work, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОШЛИ" : `ПРОВАЛЕНО: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
