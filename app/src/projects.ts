import { readdir, stat, open } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface ProjectInfo {
  name: string;
  path: string;
  encodedName: string;
  lastActivity: Date;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Claude Code encodes a project's real path into the folder name by replacing
// every "/" with "-". That mapping is LOSSY: a hyphen in the original path
// (e.g. "gravilink/ml-service") is indistinguishable from a path separator, so
// naive decoding turns ".../ml-service" into ".../ml/service" — a directory
// that does not exist. Spawning Claude Code with such a cwd surfaces as the
// misleading "spawn node ENOENT". Kept only as a last-resort fallback.
function decodePathFallback(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

// The reliable source of truth: every session .jsonl record carries the real
// working directory in its "cwd" field. We read only the head of the newest
// session file (cwd is present on the very first record) to stay cheap even for
// large transcripts.
async function readProjectCwd(jsonlPath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(jsonlPath, "r");
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(65536),
      position: 0,
    });
    const head = buffer.toString("utf8", 0, bytesRead);
    const match = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!match) return undefined;
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function listProjects(): Promise<ProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    const projectDir = join(PROJECTS_DIR, entry);
    const dirStat = await stat(projectDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    // Find most recent .jsonl file for last activity (and as the source for the
    // real cwd).
    let lastActivity = dirStat.mtime;
    let latestJsonl: string | undefined;
    try {
      const files = await readdir(projectDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(projectDir, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (fileStat && fileStat.mtime >= lastActivity) {
          lastActivity = fileStat.mtime;
          latestJsonl = filePath;
        }
      }
    } catch {
      // ignore read errors
    }

    // Prefer the real path recorded inside the session; fall back to the lossy
    // folder-name decoding only when no session file is readable.
    const realPath = latestJsonl ? await readProjectCwd(latestJsonl) : undefined;
    const projectPath = realPath || decodePathFallback(entry);
    const name = projectPath.split("/").filter(Boolean).pop() || entry;

    projects.push({
      name,
      path: projectPath,
      encodedName: entry,
      lastActivity,
    });
  }

  projects.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return projects;
}

function encodePath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

export async function findLatestSessionId(projectPath: string): Promise<string | undefined> {
  const encoded = encodePath(projectPath);
  const projectDir = join(PROJECTS_DIR, encoded);

  let files: string[];
  try {
    files = await readdir(projectDir);
  } catch {
    return undefined;
  }

  let latestFile: string | undefined;
  let latestMtime = 0;

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const fileStat = await stat(join(projectDir, file)).catch(() => null);
    if (fileStat && fileStat.mtimeMs > latestMtime) {
      latestMtime = fileStat.mtimeMs;
      latestFile = file;
    }
  }

  if (!latestFile) return undefined;
  return latestFile.replace(".jsonl", "");
}

export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}
