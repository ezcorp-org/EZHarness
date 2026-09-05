import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { FramedExecution } from "../src/protocol";

function worker(program: string, maximumBytes = 4096, timeoutMs = 1000) {
  const child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"] });
  const execution = new FramedExecution("worker", child, async (method, params) => ({ method, params }), async () => { child.kill("SIGKILL"); }, maximumBytes, timeoutMs);
  return { child, execution };
}

test("worker exit waits for asynchronous termination evidence", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "pipe", "pipe"] });
  const cleanup = Promise.withResolvers<void>();
  let completed = false;
  const execution = new FramedExecution("worker", child, async () => null, () => cleanup.promise, 4096, 1000);
  const exited = execution.exited.then(code => { completed = true; return code; });
  try {
    await once(child, "close");
    await Promise.resolve();
    expect(completed).toBe(false);
  } finally { cleanup.resolve(); await exited; }
  expect(completed).toBe(true);
});

test("worker exit reports termination failure instead of completed cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "pipe", "pipe"] });
  const execution = new FramedExecution("worker", child, async () => null, async () => { throw new Error("cleanup failed"); }, 4096, 1000);
  await expect(execution.exited).rejects.toThrow("cleanup failed");
  await expect(execution.close()).rejects.toThrow("cleanup failed");
});

test("framing accepts split UTF-8 and host reverse RPC", async () => {
  const { execution } = worker(`process.stdin.once('data',data=>{const req=JSON.parse(data);const result=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:req.id,result:'é'})+'\\n');process.stdout.write(result.subarray(0,result.length-3));setTimeout(()=>process.stdout.write(result.subarray(result.length-3)),10)});`);
  try { expect(await execution.request("echo", {})).toBe("é"); } finally { await execution.close(); }
});

test("oversized, malformed, replayed and unknown responses fail closed", async () => {
  for (const program of ["process.stdout.write('x'.repeat(5000))", "process.stdout.write('not-json\\n')", "console.log(JSON.stringify({jsonrpc:'2.0',id:'unknown',result:true}))", "process.stdin.once('data',data=>console.log(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(data).id,error:null})))"]) {
    const { execution } = worker(program);
    await expect(execution.request("echo", {})).rejects.toThrow();
    await execution.close();
  }
});

test("requests and logs have hard deadlines and output bounds", async () => {
  for (const program of ["setInterval(()=>{},1000)", "process.stderr.write('x'.repeat(5000));setInterval(()=>{},1000)"]) {
    const { execution } = worker(program, 4096, 100);
    await expect(execution.request("echo", {})).rejects.toThrow();
    await execution.close();
  }
});

test("excess queued outbound calls are rejected", async () => {
  const { execution } = worker("setInterval(()=>{},1000)");
  const pending = Array.from({ length: 32 }, () => execution.request("wait", {}).catch(error => error));
  await expect(execution.request("excess", {})).rejects.toThrow("limit");
  await execution.close();
  await Promise.all(pending);
});

test("notifications and denied reverse calls use distinct protocol envelopes", async () => {
  const child = spawn(process.execPath, ["-e", `let host;process.stdin.on('data',data=>{for(const line of data.toString().trim().split('\\n')){const req=JSON.parse(line);if(req.method){host=req.id;console.log(JSON.stringify({jsonrpc:'2.0',method:'changed',params:{version:1}}));console.log(JSON.stringify({jsonrpc:'2.0',id:'child',method:'forbidden',params:{}}));}else{console.log(JSON.stringify({jsonrpc:'2.0',id:host,result:req.error.message}));}}});`], { stdio: ["pipe", "pipe", "pipe"] });
  const execution = new FramedExecution("worker", child, async () => { throw new Error("denied"); }, async () => { child.kill("SIGKILL"); }, 4096, 1000);
  const notification = new Promise(resolve => { const unsubscribe = execution.onNotification((method, params) => { unsubscribe(); resolve({ method, params }); }); });
  try {
    expect(await execution.request("invoke", {})).toBe("Host capability denied or failed");
    expect(await notification).toEqual({ method: "changed", params: { version: 1 } });
  } finally { await execution.close(); }
});

test("framed host conflicts preserve only their stable public error", async () => {
  const child = spawn(process.execPath, ["-e", `let host;process.stdin.on('data',data=>{for(const line of data.toString().trim().split('\\n')){const req=JSON.parse(line);if(req.method){host=req.id;console.log(JSON.stringify({jsonrpc:'2.0',id:'child',method:'conflict',params:{}}));}else console.log(JSON.stringify({jsonrpc:'2.0',id:host,result:req.error}));}});`], { stdio: ["pipe", "pipe", "pipe"] });
  const execution = new FramedExecution("worker", child, async () => { throw Object.assign(new Error("private database token"), { code: "STATE_CONFLICT" }); }, async () => { child.kill("SIGKILL"); }, 4096, 1000);
  try { expect(await execution.request("invoke", {})).toEqual({ code: -32009, message: "STATE_CONFLICT: State changed; reload before retrying." }); }
  finally { await execution.close(); }
});
