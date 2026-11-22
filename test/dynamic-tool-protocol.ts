import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServer } from "../app/src/codex/app-server.js";

const dir = await mkdtemp(join(tmpdir(), "vibe-protocol-"));
process.env.VIBEIDE_STATE_DIR = dir;
const executable = join(dir, "mock-server");
await writeFile(executable, `#!${process.execPath}
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
let triggerId;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='trigger') {triggerId=m.id;send({id:'host-call',method:'item/tool/call',params:{tool:'send_file',arguments:{path:'report.txt'}}});}
 if(m.id==='host-call')send({id:triggerId,result:m.result});
 if(m.method==='approval') {triggerId=m.id;send({id:'approval-call',method:'item/commandExecution/requestApproval',params:{}});}
 if(m.id==='approval-call')send({id:triggerId,result:m.result});
});
`, { mode: 0o700 });
let calls = 0;
const server = new AppServer(() => {}, () => {}, { command: executable, requestTimeoutMs: 3000,
  async onToolCall(params) {
    calls++; assert.equal(params.tool, "send_file");
    await new Promise(resolve => setTimeout(resolve, 10));
    return { success: true, contentItems: [{ type: "inputText", text: "delivered" }] };
  },
});
try {
  assert.deepEqual(await server.request("trigger"), { success: true, contentItems: [{ type: "inputText", text: "delivered" }] });
  assert.equal(calls, 1);
  assert.deepEqual(await server.request("approval"), { decision: "decline" });
  console.log("PASS: bidirectional dynamic-tool RPC and approval handling");
} finally { server.close(); await rm(dir, { recursive: true, force: true }); }
