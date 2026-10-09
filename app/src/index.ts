import { loadConfig, listInstances } from "./config.js";
import { createBot } from "./bot.js";

const instance = process.argv[2];
if (!instance) {
  const known = listInstances();
  console.error(
    "Usage: index.ts <имя-инстанса>" +
    (known.length ? `\nДоступны: ${known.join(", ")}` : "")
  );
  process.exit(2);
}

let config;
try {
  config = loadConfig(instance);
} catch (err: any) {
  console.error(err?.message || err);
  process.exit(2);
}

let bot;
try {
  bot = await createBot(config);
} catch (err: any) {
  // Чужой токен, отозванный бот, неверные настройки — всё это перезапуском не
  // лечится, поэтому код 2: обёртка на нём останавливается, а не крутит цикл.
  console.error(err?.message || err);
  process.exit(2);
}

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`VibeCodex instance "${config.instance}" running (provider: ${config.provider}).`);
console.log(`Project: ${config.projectPath}`);

bot.start();
