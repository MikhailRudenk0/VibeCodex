/**
 * Regression test for the 429 storm seen on codeag.
 *
 * A failed send left messageId unset, so every following delta tried to send
 * again straight away. One rate limit became hundreds of them (227 in the live
 * log, retry_after climbing to 19 s) and the answer never reached the chat.
 *
 * Run: npx tsx test/streamer-ratelimit.ts
 */
import { Streamer } from "../app/src/streamer.js";

class FakeTelegramError extends Error {
  constructor(public parameters: { retry_after: number }) {
    super("Too Many Requests");
    this.description = `Too Many Requests: retry after ${parameters.retry_after}`;
  }
  description: string;
}

let sendAttempts = 0;
let editAttempts = 0;
let failSends = 2;
let lastText = "";
let messageId = 0;

const api = {
  async sendMessage(_chatId: number, text: string) {
    sendAttempts++;
    if (failSends-- > 0) throw new FakeTelegramError({ retry_after: 1 });
    lastText = text;
    return { message_id: ++messageId };
  },
  async editMessageText(_chatId: number, _messageId: number, text: string) {
    editAttempts++;
    lastText = text;
    return true;
  },
} as any;

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const started = Date.now();
  const streamer = new Streamer(api, 1);

  // 60 deltas as fast as Codex produces them, while sends are being refused.
  for (let i = 0; i < 60; i++) {
    await streamer.append(`фрагмент ${i} `);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await streamer.finalize("`gpt-6.1-sol · high`");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  попыток sendMessage: ${sendAttempts}, правок: ${editAttempts}, за ${elapsed} с`);
  console.log(`  итоговый текст: ${JSON.stringify(lastText.slice(-70))}\n`);

  check("отправок единицы, а не десятки", sendAttempts <= 5, `${sendAttempts}`);
  check("сообщение всё же доставлено", messageId > 0);
  check("индикатор прогресса убран", !lastText.includes("in progress"));
  check("статус-строка на месте", lastText.includes("gpt-6.1-sol"));
  check("текст целиком", lastText.includes("фрагмент 59"));

  console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОШЛИ" : `ПРОВАЛЕНО: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
