import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";

const config = loadConfig();
const projectPath = process.argv[2] || undefined;

const bot = await createBot(config, projectPath);

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`VibeIDE running (provider: ${config.provider}).`);
if (projectPath) {
  console.log(`Project: ${projectPath}`);
}
console.log("Send a message on Telegram to start.");

bot.start();
