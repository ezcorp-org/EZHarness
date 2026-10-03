import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelHost, echoGuest } from "./channel-guest";

test("a channel carries a frame both ways and reports the guest's exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-channel-pool-"));
  const { guest, transport, echoed, closed } = await echoGuest(new ChannelHost({ root }), "worker-solo");
  try {
    transport.stdin.write("solo-frame\n");
    expect(await echoed).toBe("solo-frame");
    transport.stdin.write("stop\n");
    expect(await closed).toBe("closed");
  } finally {
    guest.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Two live workers must not starve the host process's file-system thread pool.
 *
 * Measured on the hosted runner (4 vCPU): with two live workers, the next request
 * frame never reached the guest, and nothing moved until a worker's deadline
 * closed it ("Worker closed"). Each worker's `out` and `err` reads held one pool
 * thread each, and the pool has one thread per CPU. The child below pins the pool
 * to two threads, so the same starvation shows on any host whatever its CPU count.
 */
const child = `
import { ChannelHost, echoGuest } from ${JSON.stringify(new URL("./channel-guest.ts", import.meta.url).pathname)};
const host = new ChannelHost({ root: process.argv[1] });
const workers = [];
for (const id of ["worker-a", "worker-b"]) workers.push({ id, ...await echoGuest(host, id) });
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
