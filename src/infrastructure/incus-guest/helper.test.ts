import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGuestResponse, encodeGuestRequest, GUEST_HELPER_SHA256, GUEST_HELPER_VERSION, GuestProtocolError } from "./protocol";

const helper = new URL("./helper.py", import.meta.url).pathname;
let fixture = "";
let workspace = "";
let state = "";
const user = (await Bun.$`id -un`.text()).trim();
const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "ezh-guest-"));
  workspace = join(fixture, "workspace");
  state = join(fixture, "state");
  await mkdir(workspace);
  await mkdir(state);
});
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

async function invoke(action: string, payload: Record<string, unknown> = {}) {
  const request = { version: GUEST_HELPER_VERSION, action, sandboxId: "sandbox-a", user,
    ...(["process.start", "file.writeAtomic", "file.remove"].includes(action)
      ? { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } : {}), ...payload };
  const code = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('helper',sys.argv[1])\nh=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(h)\ntry:\n print(json.dumps(h.handle(json.loads(sys.stdin.read()),sys.argv[2],sys.argv[3])))\nexcept h.Failure as e:\n print(json.dumps({'version':h.VERSION,'ok':False,'error':{'kind':e.kind,'message':str(e)}}))\nexcept OSError as e:\n print(json.dumps({'version':h.VERSION,'ok':False,'error':{'kind':'not_found' if e.errno==2 else 'invalid','message':str(e)}}))`;
  const child = Bun.spawn(["python3", "-c", code, helper, workspace, state], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, error).toBe(0);
  return JSON.parse(output) as Record<string, any>;
}

test("protocol rejects absent or wrong helper versions", async () => {
  expect(createHash("sha256").update(Buffer.from(await Bun.file(helper).arrayBuffer())).digest("hex")).toBe(GUEST_HELPER_SHA256);
  expect(() => decodeGuestResponse(Buffer.alloc(0))).toThrow(GuestProtocolError);
  expect(() => decodeGuestResponse(Buffer.from('{"ok":true}'))).toThrow(GuestProtocolError);
  expect(() => decodeGuestResponse(Buffer.from('{"version":"1.0.0","ok":true}'))).toThrow("version mismatch");
  expect(encodeGuestRequest({ action: "file.stat", sandboxId: "sandbox-a", user }).toString()).toContain('"version":"0.1.0"');
});

test("hello verifies the actual guest identity and version", async () => {
  expect((await invoke("hello")).guestUser).toBe(user);
  expect((await invoke("hello", { version: "1.0.0" })).error.kind).toBe("unsupported");
  expect((await invoke("hello", { user: "someone-else" })).error.kind).toBe("permission");
});

test("binary file range, CAS, listing and stale revisions", async () => {
  const data = Buffer.from([0, 255, 65, 0, 128]);
  const write = await invoke("file.writeAtomic", { path: "file.bin", expectedRevision: null,
    dataBase64: data.toString("base64"), byteLength: data.length, executable: false });
  expect(write.ok).toBe(true);
  const read = await invoke("file.readRange", { path: "file.bin", revision: write.revision,
    offsetBytes: 0, lengthBytes: 100 });
  expect(Buffer.from(read.dataBase64, "base64")).toEqual(data);
  expect(read.eof).toBe(true);
  const stale = await invoke("file.writeAtomic", { path: "file.bin", expectedRevision: "stale",
    dataBase64: "", byteLength: 0, executable: false });
  expect(stale.error.kind).toBe("revision_conflict");
  const list = await invoke("file.list", { path: ".", limit: 1 });
  expect(list.entries.some((entry: any) => entry.path === "file.bin")).toBe(true);
  const removed = await invoke("file.remove", { path: "file.bin", expectedRevision: write.revision, recursive: false });
  expect(removed.ok).toBe(true);
});

test("list cursor is bound to sandbox and directory revision", async () => {
  const directory = join(workspace, "listing");
  await mkdir(directory);
  await writeFile(join(directory, "a"), "a");
  await writeFile(join(directory, "b"), "b");
  const first = await invoke("file.list", { path: "listing", limit: 1 });
  expect(first.entries.map((entry: any) => entry.path)).toEqual(["listing/a"]);
  expect(first.nextCursor.sandboxId).toBe("sandbox-a");
  const next = await invoke("file.list", { path: "listing", limit: 1, cursor: first.nextCursor });
  expect(next.entries.map((entry: any) => entry.path)).toEqual(["listing/b"]);
  const wrong = await invoke("file.list", { path: "listing", limit: 1,
    cursor: { ...first.nextCursor, sandboxId: "sandbox-b" } });
  expect(wrong.error.kind).toBe("revision_conflict");
  await writeFile(join(directory, "c"), "c");
  expect((await invoke("file.list", { path: "listing", limit: 1,
    cursor: first.nextCursor })).error.kind).toBe("revision_conflict");
});

test("file mutation replay returns the saved result without repeating the effect", async () => {
  const identity = { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
  const input = { ...identity, path: "idempotent.txt", expectedRevision: null,
    dataBase64: Buffer.from("one").toString("base64"), byteLength: 3, executable: false };
  const first = await invoke("file.writeAtomic", input);
  expect(first.ok).toBe(true);
  expect((await invoke("file.writeAtomic", input)).revision).toBe(first.revision);
  expect((await invoke("file.writeAtomic", { ...input, dataBase64: Buffer.from("two").toString("base64") })).error.kind).toBe("revision_conflict");
  const removal = { requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    path: "idempotent.txt", expectedRevision: first.revision, recursive: false };
  const removed = await invoke("file.remove", removal);
  expect((await invoke("file.remove", removal)).removedRevision).toBe(removed.removedRevision);
});

test("traversal, symlink and oversized transfer fail closed", async () => {
  const outside = join(fixture, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(workspace, "escape"));
  await symlink(fixture, join(workspace, "escaped-directory"));
  expect((await invoke("file.stat", { path: "../outside.txt" })).error.kind).toBe("invalid");
  expect((await invoke("file.readRange", { path: "escape", revision: "x", offsetBytes: 0, lengthBytes: 1 })).ok).toBe(false);
  expect((await invoke("file.writeAtomic", { path: "escape", expectedRevision: null,
    dataBase64: "WA==", byteLength: 1, executable: false })).ok).toBe(false);
  expect(await readFile(outside, "utf8")).toBe("secret");
  expect((await invoke("file.readRange", { path: "escape", revision: "x", offsetBytes: 0,
    lengthBytes: 1024 * 1024 + 1 })).ok).toBe(false);
  expect((await invoke("file.stat", { path: "escaped-directory/outside.txt" })).ok).toBe(false);
});

test("a parent swapped with an outside symlink cannot redirect descriptor access", async () => {
  const outside = join(fixture, "outside-race");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "outside");
  const parent = join(workspace, "race");
  await mkdir(parent);
  await writeFile(join(parent, "secret"), "inside");
  const script = `import os,sys\np=sys.argv[1];target=sys.argv[2]\nfor _ in range(1000):\n try:\n  os.rename(p,p+'.old');os.symlink(target,p);os.unlink(p);os.rename(p+'.old',p)\n except OSError: pass`;
  const swapper = Bun.spawn(["python3", "-c", script, parent, outside], { stdout: "ignore", stderr: "pipe" });
  for (let attempt = 0; attempt < 20; attempt++) {
    const found = await invoke("file.stat", { path: "race/secret" });
    if (found.ok) expect(found.file.sizeBytes).toBe(6);
  }
  expect(await swapper.exited).toBe(0);
});

async function waitForProcess(processId: string, terminal: string[] = ["succeeded", "failed", "cancelled", "timed_out"]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = await invoke("process.inspect", { processId, bootId });
    if (terminal.includes(reply.process?.state)) return reply.process;
    await Bun.sleep(40);
  }
  throw new Error("process did not finish");
}

test("supervised subprocess has durable identity and bounded binary output", async () => {
  const started = await invoke("process.start", { argv: ["python3", "-c", "import os;os.write(1,b'\\x00\\xff');os.write(2,b'error')"],
    cwd: ".", env: [], processDeadlineMs: Date.now() + 5000 });
  expect(started.ok).toBe(true);
  const done = await waitForProcess(started.processId);
  expect(done.state).toBe("succeeded");
  const output = await invoke("process.readOutput", { processId: started.processId, bootId,
    cursor: { sandboxId: "sandbox-a", processId: started.processId, bootId, offsetBytes: 0 }, maxBytes: 65536 });
  expect(output.eof).toBe(true);
  expect(output.chunks.map((chunk: any) => [chunk.stream, Buffer.from(chunk.dataBase64, "base64")])).toEqual([
    ["stdout", Buffer.from([0, 255])], ["stderr", Buffer.from("error")],
  ]);
  const oneByte = await invoke("process.readOutput", { processId: started.processId, bootId,
    cursor: { sandboxId: "sandbox-a", processId: started.processId, bootId, offsetBytes: 0 }, maxBytes: 1 });
  expect(Buffer.from(oneByte.chunks[0].dataBase64, "base64").length).toBe(1);
  expect(oneByte.nextCursor.offsetBytes).toBe(1);
  expect((await invoke("process.inspect", { processId: started.processId, bootId: "wrong" })).error.kind).toBe("not_found");
}, 20000);

test("lost process.start reply replays one durable process handle", async () => {
  const requestId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const marker = join(workspace, "replay-marker");
  const payload = { requestId, idempotencyKey, argv: ["python3", "-c", "open('replay-marker','a').write('x')"],
    cwd: ".", env: [], processDeadlineMs: Date.now() + 5000 };
  const first = await invoke("process.start", payload);
  expect((await waitForProcess(first.processId)).state).toBe("succeeded");
  const replay = await invoke("process.start", payload);
  expect(replay.processId).toBe(first.processId);
  expect(await readFile(marker, "utf8")).toBe("x");
  const conflict = await invoke("process.start", { ...payload, argv: ["true"] });
  expect(conflict.error.kind).toBe("revision_conflict");
}, 20000);

test("cancellation and timeout terminate real process trees", async () => {
  const start = async (timeout: number) => invoke("process.start", {
    argv: ["python3", "-c", "import subprocess,time;subprocess.Popen(['sleep','60']);time.sleep(60)"],
    cwd: ".", env: [], processDeadlineMs: Date.now() + timeout,
  });
  const cancelled = await start(5000);
  expect(cancelled.ok).toBe(true);
  await invoke("process.cancel", { processId: cancelled.processId, bootId });
  expect((await waitForProcess(cancelled.processId)).state).toBe("cancelled");
  const timed = await start(200);
  expect((await waitForProcess(timed.processId)).state).toBe("timed_out");
}, 20000);

test("output retention is bounded and reports a gap", async () => {
  const started = await invoke("process.start", { argv: ["python3", "-c", "import os;os.write(1,b'x'*(2*1024*1024))"],
    cwd: ".", env: [], processDeadlineMs: Date.now() + 5000 });
  expect((await waitForProcess(started.processId)).state).toBe("succeeded");
  let cursor = { sandboxId: "sandbox-a", processId: started.processId, bootId, offsetBytes: 0 };
  let output: Record<string, any> = {};
  for (let page = 0; page < 20; page++) {
    output = await invoke("process.readOutput", { processId: started.processId, bootId, cursor, maxBytes: 65536 });
    expect(output.chunks.reduce((total: number, chunk: any) => total + chunk.byteLength, 0)).toBeLessThanOrEqual(65536);
    cursor = output.nextCursor;
    if (output.eof) break;
  }
  expect(output.gap.reason).toBe("overflow");
  expect((await readFile(join(state, started.processId, "output.bin"))).length).toBeLessThanOrEqual(1024 * 1024);
}, 20000);
