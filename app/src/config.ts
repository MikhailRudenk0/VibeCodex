import dotenv from "dotenv";

// Load env from ENV_FILE if set, otherwise default .env in cwd.
// This allows running multiple bot instances with different .env files.
dotenv.config({ path: process.env.ENV_FILE || ".env", override: true });

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
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

  return { telegramBotToken: token, allowedUserIds };
}
