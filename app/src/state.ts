import { join, basename } from "path";
import { homedir } from "os";

/**
 * Several bot instances run from one checkout under one user account, told
 * apart only by their .env file. A single state path would make them adopt each
 * other's project and, worse, the same Codex thread — which only tolerates one
 * writer. So state is namespaced per instance.
 */
function instanceId(): string {
  const explicit = process.env.VIBEIDE_INSTANCE?.trim();
  if (explicit) return explicit;

  // run-bot.sh exports ENV_FILE=<workdir>/.env.<name>
  const envFile = process.env.ENV_FILE;
  if (envFile) {
    const name = basename(envFile);
    if (name.startsWith(".env.")) {
      const suffix = name.slice(".env.".length).trim();
      if (suffix) return suffix;
    }
  }
  return "default";
}

export function stateDir(): string {
  return process.env.VIBEIDE_STATE_DIR || join(homedir(), ".local", "state", "vibeide");
}

/** Resolved per call so tests can redirect the directory after import. */
export function stateFile(kind: string): string {
  return join(stateDir(), `${kind}-${instanceId()}.json`);
}
