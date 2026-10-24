import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { decodeGuestResponse, encodeGuestRequest, GUEST_HELPER_SHA256, GUEST_HELPER_VERSION, GuestProtocolError } from "./protocol";
import { validateSandboxProviderMethodValue } from "@ezcorp/extension-contract";
import { PREVIEW_PYTHON, waitForPreviewGuestLoopback } from "../incus-host-live-witness";

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
  return python(code, [helper, workspace, state], JSON.stringify(request));
}

async function python(code: string, args: string[], input = "") {
  const child = Bun.spawn(["python3", "-c", code, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input);
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

test("actual Git repository listing satisfies the production provider contract", async () => {
  const directory = join(workspace, "git-repository");
  await mkdir(directory);
  const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const initialized = Bun.spawn(["git", "init", "--quiet", directory], { env: fixtureEnv });
  expect(await initialized.exited).toBe(0);
  await writeFile(join(directory, "proof.txt"), "fixture\n");
  const reply = await invoke("file.list", { path: "git-repository", limit: 100 });
  const { version: _version, ...result } = reply;
  expect(() => validateSandboxProviderMethodValue("files.list", "result", result)).not.toThrow();
  expect(reply.entries.map((entry: any) => entry.path)).toEqual(["git-repository/.git", "git-repository/proof.txt"]);
  const first = await invoke("file.list", { path: "git-repository", limit: 1 });
  const { version: _firstVersion, ...firstResult } = first;
  expect(() => validateSandboxProviderMethodValue("files.list", "result", firstResult)).not.toThrow();
  expect(first.nextCursor.afterName).toBe(".git");
  expect(() => validateSandboxProviderMethodValue("files.list", "input", {
    providerId: "incus", connectionId: "connection-1", sandboxId: "sandbox-a", rpcDeadlineMs: Date.now() + 30_000,
    path: "git-repository", limit: 1, cursor: first.nextCursor,
  })).not.toThrow();
  const next = await invoke("file.list", { path: "git-repository", limit: 1, cursor: first.nextCursor });
  expect(next.entries.map((entry: any) => entry.path)).toEqual(["git-repository/proof.txt"]);
});

test("file writes and removals leave a real Git checkout clean after commit", async () => {
  const directory = join(workspace, "git-locks");
  await mkdir(directory);
  const git = async (...args: string[]) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-C", directory, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0);
    return output.trim();
  };
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(directory, "proof.txt"), "before\n");
  await git("add", "proof.txt");
  await git("commit", "-m", "seed");
  const before = await invoke("file.stat", { path: "git-locks/proof.txt" });
  const changed = await invoke("file.writeAtomic", { path: "git-locks/proof.txt", expectedRevision: before.file.revision,
    dataBase64: Buffer.from("after\n").toString("base64"), byteLength: 6, executable: false });
  expect(changed.ok).toBe(true);
  await git("add", "proof.txt");
  await git("commit", "-m", "native edit");
  expect(await git("status", "--porcelain", "--untracked-files=all")).toBe("");
  expect((await invoke("file.remove", { path: "git-locks/proof.txt", expectedRevision: changed.revision, recursive: false })).ok).toBe(true);
  await git("add", "-u");
  await git("commit", "-m", "native remove");
  expect(await git("status", "--porcelain", "--untracked-files=all")).toBe("");
});

test("path locks retain stable alias identity and refuse unsafe state, directory and leaf metadata", async () => {
  const result = await python(`import fcntl,hashlib,importlib.util,json,os,stat,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('helper',__import__('sys').argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
with tempfile.TemporaryDirectory() as d:
 root=Path(d);state=root/'state';state.mkdir(mode=0o700);repo=root/'repo';repo.mkdir();other=root/'other';other.mkdir()
 a=os.open(repo,os.O_RDONLY|os.O_DIRECTORY);alias=os.open(repo,os.O_RDONLY|os.O_DIRECTORY);b=os.open(other,os.O_RDONLY|os.O_DIRECTORY)
 req={'sandboxId':'sandbox-a'};one=h.file_lock(str(state),req,a,'proof.txt');two=h.file_lock(str(state),req,alias,'proof.txt');different=h.file_lock(str(state),req,b,'proof.txt');sandbox=h.file_lock(str(state),{'sandboxId':'sandbox-b'},a,'proof.txt');info=os.fstat(one)
 assert (info.st_dev,info.st_ino)==(os.fstat(two).st_dev,os.fstat(two).st_ino)
 assert info.st_ino not in (os.fstat(different).st_ino,os.fstat(sandbox).st_ino)
 fcntl.flock(one,fcntl.LOCK_EX)
 try:fcntl.flock(two,fcntl.LOCK_EX|fcntl.LOCK_NB);raise AssertionError('alias did not serialize')
 except BlockingIOError:pass
 os.close(one);fcntl.flock(two,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(two)
 stable=h.file_lock(str(state),req,a,'proof.txt');assert os.fstat(stable).st_ino==info.st_ino;os.close(stable);os.close(different);os.close(sandbox)
 assert list(repo.iterdir())==[]
 locks=state/'mutations'/'file-locks';target=os.fstat(a);key=hashlib.sha256(json.dumps(['sandbox-a',target.st_dev,target.st_ino,'proof.txt'],separators=(',',':')).encode()).hexdigest();leaf=locks/key
 leaf.unlink();outside=root/'outside';outside.write_text('secret');leaf.symlink_to(outside)
 try:h.file_lock(str(state),req,a,'proof.txt');raise AssertionError('symlink accepted')
 except OSError:pass
 assert outside.read_text()=='secret';leaf.unlink();os.link(outside,leaf);outside.chmod(0o600)
 try:h.file_lock(str(state),req,a,'proof.txt');raise AssertionError('hardlink accepted')
 except h.Failure:pass
 leaf.unlink();locks.chmod(0o755)
 try:h.file_lock(str(state),req,a,'proof.txt');raise AssertionError('public lock directory accepted')
 except h.Failure:pass
 locks.chmod(0o700)
 for item in locks.iterdir():item.unlink()
 locks.rmdir();locks.symlink_to(other)
 try:h.file_lock(str(state),req,a,'proof.txt');raise AssertionError('lock directory symlink accepted')
 except OSError:pass
 assert list(other.iterdir())==[];locks.unlink();mutations=state/'mutations';mutations.chmod(0o755)
 try:h.file_lock(str(state),req,a,'proof.txt');raise AssertionError('public mutations accepted')
 except h.Failure:pass
 mutations.chmod(0o700);mutations.rmdir();mutations.symlink_to(other)
 try:h.file_lock(str(state),req,a,'proof.txt');raise AssertionError('mutations symlink accepted')
 except OSError:pass
 assert list(other.iterdir())==[];mutations.unlink();state.chmod(0o777)
 try:h.file_lock(str(state),req,a,'proof.txt');raise AssertionError('writable state accepted')
 except h.Failure:pass
 denial=root/'denial-state';denial.mkdir(mode=0o700);(denial/'mutations').mkdir(mode=0o700);(denial/'mutations'/'file-locks').symlink_to(other)
 import base64,pwd
 request={'version':'0.1.0','user':pwd.getpwuid(os.geteuid()).pw_name,'sandboxId':'sandbox-a','action':'file.writeAtomic','requestId':'denied-request','idempotencyKey':'denied-key','path':'denied.txt','expectedRevision':None,'dataBase64':base64.b64encode(b'x').decode(),'byteLength':1,'executable':False}
 try:h.handle(request,str(repo),str(denial));raise AssertionError('unsafe lock performed mutation')
 except OSError:pass
 assert not (repo/'denied.txt').exists()
 journal=list((denial/'mutations').glob('*.json'));assert len(journal)==1 and json.loads(journal[0].read_bytes())['state']=='pending'
 try:h.handle(request,str(repo),str(denial));raise AssertionError('pending mutation was retried')
 except h.Failure as error:assert error.kind=='internal'
 assert not (repo/'denied.txt').exists()
 os.close(a);os.close(alias);os.close(b)
 print(json.dumps({'aliasSerialized':True,'stableInode':True,'sandboxAndParentSeparated':True,'symlinkAndHardlinkDenied':True,'privateMetadataRequired':True,'workspaceUntouched':True,'failedMutationPendingAndNotRetried':True}))
`, [helper]);
  expect(result).toEqual({ aliasSerialized: true, stableInode: true, sandboxAndParentSeparated: true,
    symlinkAndHardlinkDenied: true, privateMetadataRequired: true, workspaceUntouched: true,
    failedMutationPendingAndNotRetried: true });
});

test("different mutation identities serialize CAS writes to the same path", async () => {
  const path = "concurrent-cas.txt";
  await writeFile(join(workspace, path), "original");
  const before = await invoke("file.stat", { path });
  const replies = await Promise.all(["first", "other"].map(data => invoke("file.writeAtomic", {
    path, expectedRevision: before.file.revision, dataBase64: Buffer.from(data).toString("base64"), byteLength: data.length, executable: false,
  })));
  expect(replies.filter(reply => reply.ok)).toHaveLength(1);
  expect(replies.filter(reply => reply.error?.kind === "revision_conflict")).toHaveLength(1);
  expect(["first", "other"]).toContain(await readFile(join(workspace, path), "utf8"));
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

test("the real guest helper starts the preview service before bounded readiness accepts it", async () => {
  const reserved = createServer();
  await new Promise<void>(resolve => reserved.listen(0, "127.0.0.1", resolve));
  const address = reserved.address();
  if (!address || typeof address === "string") throw new Error("missing local test port");
  const port = address.port;
  await new Promise<void>(resolve => reserved.close(() => resolve()));
  const gate = `preview-go-${crypto.randomUUID()}`;
  const script = `import os,time\nwhile not os.path.exists("${gate}"): time.sleep(.01)\n${PREVIEW_PYTHON.replace("4173", String(port))}`;
  const service = await invoke("process.start", { argv: ["python3", "-u", "-c", script], cwd: ".",
    env: [{ name: "EZH_QUAL_CHALLENGE", value: "guest-proof" }], processDeadlineMs: Date.now() + 20_000 });
  expect(service.ok).toBe(true);
  let released = false;
  let probes = 0;
  try {
    const ready = await waitForPreviewGuestLoopback(async () => {
      probes++;
      const attempt = await invoke("process.start", { argv: ["python3", "-c",
        `import socket; s=socket.create_connection(('127.0.0.1',${port}),1); s.close()`],
      cwd: ".", env: [], processDeadlineMs: Date.now() + 3000 });
      expect(attempt.ok).toBe(true);
      return (await waitForProcess(attempt.processId)).exitCode === 0;
    }, async ms => {
      expect(ms).toBe(100);
      if (!released) {
        released = true;
        await writeFile(join(workspace, gate), "go");
        for (let check = 0; check < 100; check++) {
          const response = await fetch(`http://127.0.0.1:${port}/proof`,
            { signal: AbortSignal.timeout(1000) }).catch(() => null);
          if (response?.ok) {
            expect(await response.text()).toBe("guest-proof");
            break;
          }
          if (check === 99) throw new Error("guest preview service did not bind");
          await Bun.sleep(20);
        }
      }
    });
    expect(ready).toBe(true);
    expect(probes).toBe(2);
    expect(released).toBe(true);
    expect((await invoke("process.inspect", { processId: service.processId, bootId })).process.state).toBe("running");
  } finally {
    await invoke("process.cancel", { processId: service.processId, bootId });
    expect((await waitForProcess(service.processId)).state).toBe("cancelled");
  }
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
