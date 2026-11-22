import { createInterface } from "node:readline";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { SEND_FILE_TOOL, FILE_DELIVERY_INSTRUCTIONS } from "./send-file.js";

const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");

function deliver(args: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: process.env.VIBECODEX_FILE_SOCKET, path: "/send-file", method: "POST",
      headers: { "content-type": "application/json" } }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; if (body.length > 65_536) req.destroy(); });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); } });
    });
    req.on("error", reject);
    req.setTimeout(130_000, () => req.destroy(new Error("Delivery timeout")));
    req.end(JSON.stringify({ key: process.env.VIBECODEX_FILE_KEY, requestId: randomUUID(), arguments: args }));
  });
}

createInterface({ input: process.stdin }).on("line", line => {
  void (async () => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const respond = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        respond({ protocolVersion: "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: "vibecodex-files", version: "1.0.0" }, instructions: FILE_DELIVERY_INSTRUCTIONS }); return;
      case "ping": respond({}); return;
      case "tools/list":
        respond({ tools: [{ name: SEND_FILE_TOOL.name, description: SEND_FILE_TOOL.description,
          inputSchema: SEND_FILE_TOOL.inputSchema, annotations: { readOnlyHint: false, destructiveHint: false,
            idempotentHint: false, openWorldHint: true } }] }); return;
      case "tools/call": {
        try {
          if (message.params?.name !== "send_file") throw new Error("Unknown tool");
          if (!process.env.VIBECODEX_FILE_SOCKET || !process.env.VIBECODEX_FILE_KEY) throw new Error("No bot connection");
          const result = await deliver(message.params.arguments);
          respond({ isError: !result.success, content: result.contentItems.map((item: any) => ({ type: "text", text: item.text })) });
        } catch {
          respond({ isError: true, content: [{ type: "text", text: "Delivery was not confirmed. Check the chat before retrying." }] });
        }
        return;
      }
      default: send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  })().catch(() => {});
});
