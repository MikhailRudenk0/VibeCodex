import { join } from "path";
import { homedir } from "os";

/**
 * Несколько инстансов живут из одного каталога под одной учётной записью и
 * различаются только именем. Общий файл состояния приводил к тому, что бот
 * поднимался в чужом проекте и в чужом треде Codex, а тред терпит одного писателя.
 */
let instanceId = "default";

export function setInstanceId(name: string): void {
  const clean = name.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (clean) instanceId = clean;
}

export function stateDir(): string {
  return process.env.VIBEIDE_STATE_DIR || join(homedir(), ".local", "state", "vibeide");
}

/** Считается при каждом вызове, чтобы тесты могли переопределить каталог после импорта. */
export function stateFile(kind: string): string {
  return join(stateDir(), `${kind}-${instanceId}.json`);
}
