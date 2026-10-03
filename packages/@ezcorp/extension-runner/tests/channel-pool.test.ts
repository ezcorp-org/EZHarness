import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Two live workers must not starve the host process's file-system thread pool.
 *
 * Measured on the hosted runner (4 vCPU): with two live workers, the next request
 * frame never reached the guest, and nothing moved until a worker's deadline
 * closed it ("Worker closed"). Each worker's `out` and `err` reads held one pool
 * thread each, and the pool has one thread per CPU. The child below pins the pool
 * to two threads, so the same starvation shows on any host whatever its CPU count.
 *
 * The guests are shell processes that hold `out` and `err` the way the sandbox
 * shim does (read-write) and echo one frame back. Each reads `in` read-only, so
 * it ends with the host process whatever the outcome. The child reaches the
 * real `channelTransport` through a subclass, as channel-identity.test.ts does.
 */
const child = `
import { lstat, mkdir, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PodmanRunner } from ${JSON.stringify(new URL("../src/podman.ts", import.meta.url).pathname)};
class Channels extends PodmanRunner {
  directory(id) { return this.channelDirectory(id); }
  facts(id) { return this.channelFactsPath(id); }
  transport(id) { return this.channelTransport(id); }
}
const runner = new Channels({ root: process.argv[1] });
const workers = [];
for (const id of ["worker-a", "worker-b"]) {
  const directory = runner.directory(id);
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o755);
  const facts = {};
  for (const fifo of ["in", "out", "err"]) {
    Bun.spawnSync(["mkfifo", "-m", "666", join(directory, fifo)]);
    const created = await lstat(join(directory, fifo));
    facts[fifo] = { device: created.dev, inode: created.ino };
  }
  await writeFile(runner.facts(id), JSON.stringify(facts), { mode: 0o600 });
  const guest = spawn("sh", ["-c", 'exec 3<"$0/in" 4<>"$0/out" 5<>"$0/err"; head -n1 <&3 >&4; read -r _ <&3', directory], { stdio: "ignore" });
  const transport = await runner.transport(id);
  // Both reads run for a worker's whole life, as FramedExecution reads both.
  transport.stderr.on("data", () => {});
  const echoed = new Promise(resolve => transport.stdout.on("data", chunk => resolve(String(chunk).trim())));
  const closed = new Promise(resolve => transport.once("close", () => resolve("closed")));
  workers.push({ id, guest, transport, echoed, closed });
}
const report = {};
for (const worker of workers) {
  worker.transport.stdin.write(worker.id + "-frame\\n");
  // A bound on liveness only: a starved pool never delivers, so the child must still answer.
  report[worker.id] = await Promise.race([worker.echoed, Bun.sleep(4_000).then(() => "starved")]);
}
for (const worker of workers) {
  worker.transport.stdin.write("stop\\n");
  report[worker.id + ":exit"] = await Promise.race([worker.closed, Bun.sleep(4_000).then(() => "still open")]);
}
for (const worker of workers) worker.guest.kill("SIGKILL");
console.log(JSON.stringify(report));
process.exit(0);
`;

test("two live workers still exchange frames and report their exits when the file-system pool has two threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-channel-pool-"));
  const run = Bun.spawn([process.execPath, "-e", child, root], { env: { ...process.env, UV_THREADPOOL_SIZE: "2" }, stdout: "pipe", stderr: "pipe" });
  try {
    // A bound on liveness only: on a starved pool the child cannot even set up the second worker.
    const exited = await Promise.race([run.exited.then(() => "exited"), Bun.sleep(20_000).then(() => "still blocked after 20 s")]);
    expect(exited).toBe("exited");
    const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect({ code: run.exitCode, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ "worker-a": "worker-a-frame", "worker-b": "worker-b-frame", "worker-a:exit": "closed", "worker-b:exit": "closed" });
  } finally {
    run.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
