import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeAudio, transcriptionTimeoutMs } from "../app/src/transcription.js";

test("recording length determines a finite CPU budget", () => {
  for (const duration of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(transcriptionTimeoutMs(duration), 120_000);
  }
  assert.ok(transcriptionTimeoutMs(44) > 120_000);
  assert.ok(transcriptionTimeoutMs(137) > transcriptionTimeoutMs(44));
  assert.equal(transcriptionTimeoutMs(100_000), 30 * 60_000);
});

test("launcher preserves arguments and reports process failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vibecodex-transcription-"));
  try {
    const script = join(directory, "recognize speech");
    await writeFile(script, `#!${process.execPath}
const argument = process.argv[2];
if (argument === "slow") setTimeout(() => console.log("late"), 10000);
else if (argument === "failure") { console.error("decoder failure"); process.exit(7); }
else if (argument === "empty") console.log("  ");
else console.log("  " + argument + "  ");
`);
    await chmod(script, 0o700);
    await t.test("spaces and shell metacharacters stay one literal argument", async () => {
      const unwanted = join(directory, "unwanted");
      const argument = `audio name; touch ${unwanted}`;
      assert.equal(await transcribeAudio(argument, {scriptPath:script}), argument);
      await assert.rejects(access(unwanted));
    });
    await t.test("stderr and exit code survive", async () => {
      await assert.rejects(transcribeAudio("failure", {scriptPath:script}), /код 7.*decoder failure/);
    });
    await t.test("empty output is rejected", async () => {
      await assert.rejects(transcribeAudio("empty", {scriptPath:script}), /пустой текст/);
    });
    await t.test("timeout names the limit and recording duration", async () => {
      await assert.rejects(transcribeAudio("slow", {scriptPath:script, timeoutMs:200, durationSeconds:137}),
                           /превысило лимит 1 с для аудио 137 с/);
    });
    await t.test("missing launcher is explained", async () => {
      await assert.rejects(transcribeAudio("audio", {scriptPath:join(directory,"absent")}), /Не установлен скрипт/);
    });
    await t.test("zero timeout cannot silently disable the time limit", async () => {
      await assert.rejects(transcribeAudio("audio", {scriptPath:script, timeoutMs:0}), /положительным/);
    });
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
});
