import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { RunnerClient, RunnerError } from "../src";

/**
 * A runner that stops or restarts while a call is open (a lane teardown, a service restart) must reach the
 * host as a retryable `runner_unavailable`, not as a raw socket error. Before this, `socket hang up` arrived as
 * a plain Error, so the lifecycle logged "Operation failed with an unclassified error" and failed the build for
 * good (real-auth lane, run 40217994555: the bundled scratchpad build at teardown).
 * Only failures BEFORE any response are mapped; a response with an error status keeps its own code.
 */
const TOKEN = "test-service-credential-32-bytes-minimum";

async function withSocket(serve: (server: Server) => void, run: (client: RunnerClient) => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/ez-runner-transport-");
  const socketPath = join(directory, "runner.sock");
  const server = createServer();
  serve(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run(new RunnerClient({ socketPath, token: TOKEN }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test("a runner that closes the connection before it answers is runner_unavailable, retryable", async () => {
  await withSocket((server) => server.on("connection", (socket) => socket.once("data", () => socket.destroy())), async (client) => {
    const error = await client.inspect("worker").then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerError);
    expect(error).toMatchObject({ code: "runner_unavailable", retryable: true, stage: "runner", detail: { errorCode: "ECONNRESET" } });
  });
});

test("a response with an error status keeps its own classification", async () => {
  await withSocket((server) => server.on("connection", (socket) => socket.once("data", () => {
    const body = JSON.stringify({ error: { code: "runner_busy", message: "busy", stage: "runner", retryable: true } });
    socket.end(`HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  })), async (client) => {
    const error = await client.inspect("worker").then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: "runner_busy", retryable: true });
  });
});
