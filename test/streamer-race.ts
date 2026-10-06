/**
 * Regression test for the "stuck ⏳ in progress…" message.
 *
 * Streamer throttles edits behind a timer, so an edit can still be in flight
 * when the turn ends. If finalize() issues its own edit without waiting, the two
 * land out of order and the throttled one — older text, progress suffix — wins.
 * No network and no model: only edit ordering matters here.
 *
 * Run: npx tsx test/streamer-race.ts
 */
import { Streamer } from "../app/src/streamer.js";

const applied: string[] = [];
let editCount = 0;

const slowFirstApi = {
  async sendMessage(_chatId: number, text: string) {
    applied.push(text);
    return { message_id: 1 };
  },
  async editMessageText(_chatId: number, _messageId: number, text: string) {
    // The throttled edit is slow; the final one that follows is fast.
    const delay = editCount++ === 0 ? 400 : 10;
    await new Promise((resolve) => setTimeout(resolve, delay));
    applied.push(text);
    return true;
  },
} as any;

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const streamer = new Streamer(slowFirstApi, 1);

  await streamer.append("Хорошо, спасибо! Как");
  await streamer.append(" у тебя дела?");

  // Let the throttle timer fire so an edit is genuinely in flight.
  await new Promise((resolve) => setTimeout(resolve, 330));

  await streamer.finalize("`gpt-6.1-sol · high`");

  // Anything still in flight has to have landed before we judge the result.
  await new Promise((resolve) => setTimeout(resolve, 800));

  const last = applied.at(-1) ?? "";
  console.log(`\n  правок: ${editCount}, состояний: ${applied.length}`);
  console.log(`  последнее состояние: ${JSON.stringify(last)}\n`);

  check("последним применён финальный текст", !last.includes("in progress"), last.slice(0, 60));
  check("текст целиком", last.includes("у тебя дела?"));
  check("статус-строка на месте", last.includes("gpt-6.1-sol"));

  console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОШЛИ" : `ПРОВАЛЕНО: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
