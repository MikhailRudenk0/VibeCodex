/**
 * Regression test: two bot instances share a checkout, a user account and a
 * home directory, so a single state path made the second instance adopt the
 * first one's project and Codex thread. State must be namespaced per instance.
 *
 * Run: npx tsx test/state-isolation.ts
 */
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const dir = await mkdtemp(join(tmpdir(), "vibeide-state-"));
process.env.VIBEIDE_STATE_DIR = dir;

const { stateFile } = await import("../app/src/state.js");

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

process.env.ENV_FILE = "/home/myuser/vibeide/.env.main";
const main = stateFile("state-codex");

process.env.ENV_FILE = "/home/myuser/vibeide/.env.second";
const second = stateFile("state-codex");

delete process.env.ENV_FILE;
const fallback = stateFile("state-codex");

process.env.VIBEIDE_INSTANCE = "explicit";
const explicit = stateFile("state-codex");
delete process.env.VIBEIDE_INSTANCE;

console.log(`  main:     ${main}`);
console.log(`  second:   ${second}`);
console.log(`  fallback: ${fallback}`);
console.log(`  explicit: ${explicit}\n`);

check("инстансы не делят файл", main !== second);
check("имя взято из ENV_FILE", main.endsWith("state-codex-main.json"));
check("второй инстанс свой", second.endsWith("state-codex-second.json"));
check("без ENV_FILE есть запасное имя", fallback.endsWith("state-codex-default.json"));
check("VIBEIDE_INSTANCE перекрывает", explicit.endsWith("state-codex-explicit.json"));
check("каталог берётся из VIBEIDE_STATE_DIR", main.startsWith(dir));

await rm(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОШЛИ" : `ПРОВАЛЕНО: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
