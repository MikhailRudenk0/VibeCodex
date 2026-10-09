import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

export type Provider = "codex" | "claude";

export interface Config {
  /** Имя инстанса — оно же выбирает весь блок настроек. */
  instance: string;
  telegramBotToken: string;
  /** Если задан, бот откажется стартовать под чужим токеном. */
  expectedUsername?: string;
  allowedUserIds: number[];
  projectPath: string;
  provider: Provider;
  codex: {
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
    toolNotices: boolean;
  };
}

const CONFIG_NAMES = ["vibecodex.yaml", "vibecodex.yml", "vibecodex.json"];

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function findConfigFile(): string {
  const explicit = process.env.VIBECODEX_CONFIG;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`VIBECODEX_CONFIG указывает на несуществующий файл: ${explicit}`);
    }
    return explicit;
  }
  for (const name of CONFIG_NAMES) {
    const path = join(repoRoot(), name);
    if (existsSync(path)) return path;
  }
  throw new Error(
    `Не найден файл настроек. Создайте ${CONFIG_NAMES[0]} в ${repoRoot()} ` +
    `по образцу vibecodex.example.yaml, либо укажите путь в VIBECODEX_CONFIG.`
  );
}

function fail(path: string, instance: string, message: string): never {
  throw new Error(`${path}, инстанс "${instance}": ${message}`);
}

function parseAllowedUserIds(raw: unknown, path: string, instance: string): number[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (list.length === 0) {
    fail(path, instance, "не указан ни один allowedUserIds — боту некому отвечать");
  }
  return list.map((value) => {
    const id = typeof value === "number" ? value : parseInt(String(value).trim(), 10);
    if (!Number.isFinite(id)) {
      fail(path, instance, `allowedUserIds содержит не число: ${JSON.stringify(value)}`);
    }
    return id;
  });
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  path: string,
  instance: string
): T {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(text)) {
    fail(path, instance, `${field} должно быть одним из ${allowed.join(", ")}, а не "${value}"`);
  }
  return text as T;
}

/**
 * Читает настройки одного инстанса.
 *
 * Токен, список пользователей и рабочий каталог берутся из одного блока, выбранного
 * по имени. Раньше токен приходил из своего .env, а каталог — отдельным аргументом
 * командной строки, и они могли разойтись: бот отвечал не тем и работал не там.
 */
export function loadConfig(instance: string): Config {
  const path = findConfigFile();
  const raw = readFileSync(path, "utf-8");

  let document: any;
  try {
    document = path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  } catch (err: any) {
    throw new Error(`${path}: не удалось разобрать файл — ${err?.message || err}`);
  }

  const instances = document?.instances;
  if (!instances || typeof instances !== "object") {
    throw new Error(`${path}: нет раздела "instances"`);
  }

  const block = instances[instance];
  if (!block) {
    const available = Object.keys(instances);
    throw new Error(
      `${path}: нет инстанса "${instance}". ` +
      (available.length ? `Есть: ${available.join(", ")}` : "Файл не содержит ни одного инстанса.")
    );
  }

  const bot = block.bot ?? block.telegram ?? {};
  const token = String(bot.token ?? "").trim();
  if (!token) fail(path, instance, "не указан bot.token");
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    fail(path, instance, "bot.token не похож на токен Telegram (ожидается «123456:AA...»)");
  }

  const projectPath = String(block.projectPath ?? "").trim();
  if (!projectPath) fail(path, instance, "не указан projectPath");
  if (!isAbsolute(projectPath)) {
    fail(path, instance, `projectPath должен быть абсолютным путём, а не "${projectPath}"`);
  }
  if (!existsSync(projectPath)) {
    fail(path, instance, `каталог projectPath не существует: ${projectPath}`);
  }

  const codex = block.codex ?? {};

  return {
    instance,
    telegramBotToken: token,
    expectedUsername: bot.username ? String(bot.username).replace(/^@/, "") : undefined,
    allowedUserIds: parseAllowedUserIds(bot.allowedUserIds, path, instance),
    projectPath,
    provider: oneOf(block.provider, ["codex", "claude"] as const, "codex", "provider", path, instance),
    codex: {
      sandboxMode: oneOf(
        codex.sandboxMode,
        ["read-only", "workspace-write", "danger-full-access"] as const,
        "danger-full-access", "codex.sandboxMode", path, instance
      ),
      approvalPolicy: oneOf(
        codex.approvalPolicy,
        ["never", "on-request", "on-failure", "untrusted"] as const,
        "never", "codex.approvalPolicy", path, instance
      ),
      // По умолчанию выключено: одно сообщение на запрос, ничего лишнего.
      toolNotices: codex.toolNotices === true,
    },
  };
}

/** Имена инстансов из файла настроек — для понятных сообщений об ошибке. */
export function listInstances(): string[] {
  try {
    const path = findConfigFile();
    const raw = readFileSync(path, "utf-8");
    const document = path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    return Object.keys(document?.instances ?? {});
  } catch {
    return [];
  }
}
