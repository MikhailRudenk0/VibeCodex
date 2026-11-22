import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { InputFile, type Api, type RawApi } from "grammy";
import { ProjectScope } from "./project-scope.js";
import { audit } from "./audit.js";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const SEND_FILE_TOOL = {
  type: "function",
  name: "send_file",
  description: "Send an existing project file as a document attachment to the user's current Telegram chat. Use this to deliver requested reports, PDFs, images, spreadsheets, source files or archives; do not ask the user to run /file. The bot fixes the recipient. Only report delivery after success. Do not automatically retry an uncertain upload.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      path: { type: "string", description: "Absolute project file path, or path relative to the current project." },
      caption: { type: "string", maxLength: 1024, description: "Optional short plain-text caption." },
    },
    required: ["path"],
  },
};

export const FILE_DELIVERY_INSTRUCTIONS = "You are talking to the user through Telegram. When the user requests a file or your task produces a deliverable intended for them, use send_file to attach the actual file to this chat. Save deliverables inside the current project. Do not substitute a server path or instructions to run /file for the attachment. Only say a file was sent after the tool succeeds. If delivery fails, explain it accurately; do not automatically retry an upload whose delivery is uncertain. Never send credentials or unrelated files without an explicit user request.";

export interface ToolResult {
  success: boolean;
  contentItems: { type: "inputText"; text: string }[];
}

export function toolResult(success: boolean, text: string): ToolResult {
  return { success, contentItems: [{ type: "inputText", text }] };
}

/** Snapshot a bounded regular file from an opened descriptor, not a later path reopen. */
export async function readProjectFile(scope: ProjectScope, cwd: string, path: string, maxBytes = MAX_FILE_BYTES) {
  scope.directory(cwd);
  const canonical = scope.resolve(path, cwd);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Only regular files can be sent; archive directories first");
    if (info.nlink !== 1) throw new Error("Hard-linked files cannot be sent; save a regular copy in the project");
    if (info.size > maxBytes) throw new Error("File exceeds the 50 MiB upload limit; split or compress it first");
    // Linux: catch parent-directory replacement between realpath() and open().
    if (process.platform === "linux") scope.resolve(await realpath(`/proc/self/fd/${file.fd}`));
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("File exceeds the 50 MiB upload limit; split or compress it first");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { filename: basename(canonical), bytes: Buffer.concat(chunks, total) };
  } finally { await file.close(); }
}

export async function sendProjectFile(
  api: Api<RawApi>, scope: ProjectScope, chatId: number, cwd: string,
  args: unknown, signal?: AbortSignal, messageThreadId?: number,
): Promise<{ messageId: number; filename: string; size: number }> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected path and optional caption");
  const input = args as Record<string, unknown>;
  if (Object.keys(input).some(key => !["path", "caption"].includes(key))) throw new Error("Only path and caption are accepted; the recipient is fixed");
  if (typeof input.path !== "string" || !input.path.trim() || input.path.includes("\0")) throw new Error("path must be a nonempty file path");
  if (input.caption !== undefined && (typeof input.caption !== "string" || input.caption.length > 1024)) throw new Error("caption must be text of at most 1024 characters");
  const file = await readProjectFile(scope, cwd, input.path);
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 120_000);
  try {
    const message = await api.sendDocument(chatId, new InputFile(file.bytes, file.filename), {
      ...(input.caption ? { caption: input.caption as string } : {}),
      ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
    // grammY types use the older abort-controller package; node-fetch accepts native signals too.
    }, controller.signal as unknown as Parameters<Api<RawApi>["sendDocument"]>[3]);
    audit("file.delivered", { chatId, messageId: message.message_id, bytes: file.bytes.length });
    return { messageId: message.message_id, filename: file.filename, size: file.bytes.length };
  } catch {
    audit("file.delivery_failed", { chatId });
    throw new Error("Telegram upload failed or delivery could not be confirmed. Do not claim success or automatically retry; the user should check the chat first.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
