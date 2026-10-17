import { expect, test } from "bun:test";
import { mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Runner } from "@ezcorp/extension-contract";
import { RunnerClient } from "../src";
import { startRunnerService } from "../src/service";

/**
 * The host keeps no idle connection to the runner (W4H-30). Each call is its own connection, closed when its
 * response ends, so a host with no runner call in flight holds no runner socket. Before this, the client's
 * keep-alive pool kept each finished call's connection idle for about 5 s, so the number of runner sockets a
 * sample saw was the number of calls that had overlapped in the last 5 s: one or two. The production resource
 * proof caught it growing from one to two after its first lifecycle sample (PR 341, ci 38525604869; W4H-30 R1
 * named the two app sockets as connections to runner.sock with no runner request in flight).
 */
const TOKEN = "test-service-credential-32-bytes-minimum";

async function sockets(): Promise<number> {
  let count = 0;
  for (const fd of await readdir("/proc/self/fd")) {
    try { if ((await readlink(`/proc/self/fd/${fd}`)).startsWith("socket:")) count++; } catch { /* closed while listed */ }
  }
  return count;
}

/** Await an observed state. The enclosing test budget is the only bound. */
async function until(observed: () => Promise<boolean>): Promise<void> { while (!await observed()) await Bun.sleep(5); }

test("calls through the real service and its peer gateway, sequential or concurrent, leave no runner connection open once they settle", async () => {
  const directory = await mkdtemp("/tmp/ez-w4h30-client-");
  const socketPath = join(directory, "runner.sock");
  const runner = { inspect: async (id: string) => ({ id, state: "running", diagnostics: [] }) } as unknown as Runner;
  const service = await startRunnerService({ runner, socketPath, token: TOKEN, allowedUid: process.getuid!() });
  try {
    const before = await sockets();
    const client = new RunnerClient({ socketPath, token: TOKEN });
    for (let call = 0; call < 3; call++) expect((await client.inspect("worker")).state).toBe("running");
    // Two calls in flight at once: a keep-alive pool grows to two connections here, and the gateway keeps both open.
    await Promise.all([client.inspect("worker"), client.inspect("worker")]);
    await until(async () => await sockets() <= before);
    expect(await sockets()).toBe(before);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("every call asks the runner to close its connection when the response ends", async () => {
  const directory = await mkdtemp("/tmp/ez-w4h30-client-");
  const socketPath = join(directory, "runner.sock");
  const connection: (string | null)[] = [];
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      connection.push(request.headers.get("connection"));
      await request.text();
      return new Response(JSON.stringify({ id: "worker", state: "running", diagnostics: [] }), { headers: { "content-type": "application/json" } });
    },
  });
  try {
    const client = new RunnerClient({ socketPath, token: TOKEN });
    await client.inspect("worker");
    await Promise.all([client.inspect("worker"), client.inspect("worker")]);
    expect(connection).toEqual(["close", "close", "close"]);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
