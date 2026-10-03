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
 * Runs `body` in a child Bun whose file-system thread pool has two threads, so pool
 * starvation shows on any host whatever its CPU count. The body prints one JSON
 * report; a starved child cannot finish, and the parent says so by name.
 */
async function withTwoPoolThreads(body: string): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "ez-channel-pool-"));
  const child = `import { ChannelHost, echoGuest } from ${JSON.stringify(new URL("./channel-guest.ts", import.meta.url).pathname)};\nconst host = new ChannelHost({ root: process.argv[1] });\n${body}\nprocess.exit(0);`;
  const run = Bun.spawn([process.execPath, "-e", child, root], { env: { ...process.env, UV_THREADPOOL_SIZE: "2" }, stdout: "pipe", stderr: "pipe" });
  try {
    // A bound on liveness only: on a starved pool the child cannot even set up its next channel.
    const exited = await Promise.race([run.exited.then(() => "exited"), Bun.sleep(20_000).then(() => "still blocked after 20 s")]);
    expect(exited).toBe("exited");
    const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect({ code: run.exitCode, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout);
  } finally {
    run.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Two live workers must not starve the host process's file-system thread pool.
 *
 * Measured on the hosted runner (4 vCPU): with two live workers, the next request
 * frame never reached the guest, and nothing moved until a worker's deadline
 * closed it ("Worker closed"). Each worker's `out` and `err` reads held one pool
 * thread each, and the pool has one thread per CPU.
 */
test("two live workers still exchange frames and report their exits when the file-system pool has two threads", async () => {
  expect(await withTwoPoolThreads(`
const workers = [];
for (const id of ["worker-a", "worker-b"]) workers.push({ id, ...await echoGuest(host, id) });
const report = {};
for (const worker of workers) {
  worker.transport.stdin.write(worker.id + "-frame\\n");
  report[worker.id] = await Promise.race([worker.echoed, Bun.sleep(4_000).then(() => "starved")]);
}
for (const worker of workers) {
  worker.transport.stdin.write("stop\\n");
  report[worker.id + ":exit"] = await Promise.race([worker.closed, Bun.sleep(4_000).then(() => "still open")]);
}
for (const worker of workers) worker.guest.kill("SIGKILL");
console.log(JSON.stringify(report));`)).toEqual({ "worker-a": "worker-a-frame", "worker-b": "worker-b-frame", "worker-a:exit": "closed", "worker-b:exit": "closed" });
});

/**
 * A guest that stops reading its input must not stall the host either. A pipe
 * holds 64 KiB; a write beyond that waits for the reader. If the write waits on
 * a pool thread, two such guests take the whole pool and every other worker's
 * channel stops, so a hostile guest could stall the runner.
 */
test("two guests that never read their input do not stop a third worker's channel when the pool has two threads", async () => {
  expect(await withTwoPoolThreads(`
const silent = [await echoGuest(host, "silent-a", { reads: false }), await echoGuest(host, "silent-b", { reads: false })];
for (const guest of silent) guest.transport.stdin.write("x".repeat(256 * 1024) + "\\n");
const live = await Promise.race([echoGuest(host, "worker-c"), Bun.sleep(4_000).then(() => undefined)]);
const report = { opened: live !== undefined };
if (live) {
  live.transport.stdin.write("worker-c-frame\\n");
  report.echo = await Promise.race([live.echoed, Bun.sleep(4_000).then(() => "starved")]);
  live.guest.kill("SIGKILL");
}
for (const guest of silent) guest.guest.kill("SIGKILL");
console.log(JSON.stringify(report));`)).toEqual({ opened: true, echo: "worker-c-frame" });
});
