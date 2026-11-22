import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** UI validation complements the service's Linux user and filesystem boundary. */
export class ProjectScope {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Project root must be absolute");
    this.root = realpathSync(root);
    if (!statSync(this.root).isDirectory()) throw new Error("Project root must be a directory");
  }

  resolve(path: string, cwd = this.root): string {
    if (typeof path !== "string" || !path.trim()) throw new Error("A nonempty project path is required");
    const resolved = realpathSync(resolve(cwd, path));
    const rel = relative(this.root, resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Path is outside this bot's project group");
    }
    return resolved;
  }

  directory(path: string): string {
    const resolved = this.resolve(path);
    if (!statSync(resolved).isDirectory()) throw new Error("Project must be a directory");
    return resolved;
  }

  allowsDirectory(path: string): boolean {
    try { this.directory(path); return true; } catch { return false; }
  }
}
