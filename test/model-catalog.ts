import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "vibe-model-catalog-"));
process.env.VIBEIDE_STATE_DIR = work;
const { CodexBridge } = await import("../app/src/codex/bridge.js");
const bridge: any = new CodexBridge({} as any, work);
const model = (id: string, efforts = ["low", "medium"], hidden = false) => ({
  id, displayName: id, hidden,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })),
});
let catalog = [model("gpt-6.1-sol")];
let failed = false;
let calls = 0;
bridge.server = { async request(method: string, params: unknown) {
  assert.equal(method, "model/list", "Model inventory must never start inference");
  assert.deepEqual(params, {limit: 100});
  calls++;
  if (failed) throw new Error("temporary catalog failure");
  return {data: catalog};
} };
try {
  assert.deepEqual((await bridge.getSupportedModels()).map((m: any) => m.value), ["gpt-6.1-sol"]);
  catalog = [model("gpt-6.2-sol", ["low", "medium", "high"]), model("gpt-6.2-astra"), model("internal-review", ["low"], true)];
  assert.deepEqual((await bridge.getSupportedModels()).map((m: any) => m.value), ["gpt-6.2-sol", "gpt-6.2-astra"]);
  assert.equal(calls, 2, "A second picker request must refresh the catalog");
  assert(!bridge.modelEfforts.has("gpt-6.1-sol"), "Removed model effort choices must not survive refresh");
  bridge.model = "gpt-6.2-sol";
  bridge.effort = "low";
  assert.deepEqual(await bridge.getSupportedEfforts(), ["low", "medium", "high"]);
  assert.equal(bridge.model, "gpt-6.2-sol");
  assert.equal(bridge.effort, "low", "Listing models must not change selected effort");
  failed = true;
  assert.deepEqual((await bridge.getSupportedModels()).map((m: any) => m.value), ["gpt-6.2-sol", "gpt-6.2-astra"]);
  failed = false;
  catalog = [];
  assert.deepEqual(await bridge.getSupportedModels(), []);
  assert.equal(bridge.modelEfforts.size, 0);
  console.log("PASS: new 6.2 models, effort refresh, hidden/removed models, fallback, empty catalog; inference calls 0");
} finally {
  rmSync(work, {recursive: true, force: true});
}
