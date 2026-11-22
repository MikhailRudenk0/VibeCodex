import { appendFileSync, mkdirSync, statSync, renameSync } from "fs";
import { join } from "path";
import { stateDir, stateFile } from "./state.js";

/** Metadata only: never record prompts, response bodies, tokens or API URLs. */
export function audit(event: string, fields: Record<string, unknown> = {}): void {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const path = stateFile("audit");
    try { if (statSync(path).size > 5_000_000) renameSync(path, path + ".previous"); } catch {}
    appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), pid: process.pid,
      event, ...fields }) + "\n", { mode: 0o600 });
  } catch (err) { console.error("Audit write failed", (err as Error).name); }
}
