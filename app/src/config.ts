import dotenv from "dotenv";

// Load env from ENV_FILE if set, otherwise default .env in cwd.
// This allows running multiple bot instances with different .env files.
dotenv.config({ path: process.env.ENV_FILE || ".env", override: true });

export type Provider = "codex" | "claude";

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  provider: Provider;
  codex: {
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
    toolNotices: boolean;
  };
}

function parseProvider(raw: string | undefined): Provider {
  const value = (raw || "codex").trim().toLowerCase();
  if (value !== "codex" && value !== "claude") {
    throw new Error(`AGENT_PROVIDER must be "codex" or "claude", got: ${raw}`);
  }
  return value;
}

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN not set in .env");
  }

  const userIdStr = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!userIdStr) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID not set in .env");
  }
  const allowedUserIds = userIdStr.split(",").map((id) => {
    const parsed = parseInt(id.trim(), 10);
    if (isNaN(parsed)) {
      throw new Error(`TELEGRAM_ALLOWED_USER_ID contains invalid number: ${id}`);
    }
    return parsed;
  });
  if (allowedUserIds.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must contain at least one user ID");
  }

  const sandboxMode = (process.env.CODEX_SANDBOX_MODE || "danger-full-access") as Config["codex"]["sandboxMode"];
  const approvalPolicy = (process.env.CODEX_APPROVAL_POLICY || "never") as Config["codex"]["approvalPolicy"];

  return {
    telegramBotToken: token,
    allowedUserIds,
    provider: parseProvider(process.env.AGENT_PROVIDER),
    codex: {
      sandboxMode,
      approvalPolicy,
      // Off by default: one streamed message per request, same as before.
      toolNotices: process.env.CODEX_TOOL_NOTICES === "true",
    },
  };
}
