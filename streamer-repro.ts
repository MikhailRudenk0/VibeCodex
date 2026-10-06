import { Streamer } from "./app/src/streamer.js";
let lastText = "";
const api: any = {
  async sendMessage(_c: number, text: string) { await new Promise(r => setTimeout(r, 50)); lastText = text; return { message_id: Math.floor(Math.random()*1000) }; },
  async editMessageText(_c: number, _m: number, text: string) { await new Promise(r => setTimeout(r, 50)); lastText = text; return true; },
};
const s = new Streamer(api, 1, 42);
// emit deltas synchronously, fire-and-forget, like CodexBridge does
let expected = "";
for (let i = 0; i < 500; i++) {
  const delta = `chunk${i.toString().padStart(4,"0")} `;
  expected += delta;
  void s.append(delta);
}
await new Promise(r => setTimeout(r, 2000));
await s.finalize();
// @ts-ignore private
const got: string = (s as any).text;
console.log("expected length", expected.length);
console.log("final visible text length", got.length);
console.log("missing chunks:", [...expected.matchAll(/chunk(\d{4})/g)].map(m=>m[1]).filter(n => !got.includes("chunk"+n)).slice(0,10));
