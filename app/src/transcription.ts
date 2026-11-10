import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** CPU recognition can take several times the recording's duration. */
export function transcriptionTimeoutMs(durationSeconds?: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds! <= 0) return 120_000;
  return Math.min(30 * 60_000, Math.max(120_000, 60_000 + Math.ceil(durationSeconds! * 6_000)));
}

interface TranscriptionOptions {
  durationSeconds?: number;
  scriptPath?: string;
  timeoutMs?: number;
}

export function transcribeAudio(audioPath: string, options: TranscriptionOptions = {}): Promise<string> {
  // Use the versioned launcher. An old ignored bin/transcribe.sh cannot replace it.
  const script = options.scriptPath ?? join(root, "scripts", "transcribe.sh");
  const timeout = options.timeoutMs ?? transcriptionTimeoutMs(options.durationSeconds);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Promise.reject(new Error("Лимит распознавания должен быть положительным."));
  }
  if (!existsSync(script)) {
    return Promise.reject(new Error("Не установлен скрипт распознавания scripts/transcribe.sh."));
  }
  return new Promise((resolve, reject) => {
    execFile(script, [audioPath], { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed && error.signal === "SIGTERM") {
          reject(new Error(`Распознавание превысило лимит ${Math.ceil(timeout / 1000)} с` +
            (options.durationSeconds ? ` для аудио ${options.durationSeconds} с.` : ".")));
        } else {
          const status = error.signal ? `сигнал ${error.signal}` : `код ${error.code}`;
          reject(new Error(`Ошибка распознавания (${status}): ${stderr.trim() || error.message}`));
        }
        return;
      }
      const text = stdout.trim();
      if (!text) reject(new Error("Распознаватель вернул пустой текст."));
      else resolve(text);
    });
  });
}
