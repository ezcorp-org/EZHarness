import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestIncusSupervisorReceipt, requestIncusSupervisorRestart,
  type SupervisorRestartRequest } from "./incus-qualification-supervisor-client";
import type { SignedRestartHandoff } from "./incus-qualification-checkpoint";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function server(reply: string | ((request: unknown) => string | null), delayMs = 0): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "incus-supervisor-client-"));
  roots.push(root);
  const path = join(root, "control.sock");
  const listener = createServer(socket => {
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      const response = typeof reply === "string" ? reply : reply(JSON.parse(data));
      if (response !== null) setTimeout(() => socket.end(response), delayMs);
    });
  });
  servers.push(listener);
  await new Promise<void>(resolve => listener.listen(path, resolve));
  return path;
}

const restart: SupervisorRestartRequest = {
  version: 1, action: "restart", runId: "run", nonce: "nonce", deadlineMs: 1,
  scope: { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset" },
  fixtureOperationId: "fixture", bindingId: "binding", generation: 3,
  connectionRevision: 2, lastOperationId: "operation", beforeDigest: "a".repeat(64),
};

test("client sends exact restart and receipt frames", async () => {
  const restartSocket = await server(input => {
    expect(input).toEqual(restart);
    return '{"accepted":true}\n';
  });
  await requestIncusSupervisorRestart(restartSocket, restart);
  const receipt: SignedRestartHandoff = { payload: {
    ...restart, oldProcess: { pid: 1, startTicks: "1" },
    newProcess: { pid: 2, startTicks: "2" }, afterDigest: "b".repeat(64),
  }, signature: "signature" };
  const receiptSocket = await server(input => {
    expect(input).toEqual({ version: 1, action: "receipt", runId: "run", nonce: "nonce",
      afterDigest: "b".repeat(64) });
    return `${JSON.stringify({ receipt })}\n`;
  });
  expect(await requestIncusSupervisorReceipt(receiptSocket, "run", "nonce", "b".repeat(64),
    Date.now() + 20_000))
    .toEqual(receipt);
});

test("client waits for independent receipt verification beyond five seconds", async () => {
  const receipt: SignedRestartHandoff = { payload: {
    ...restart, oldProcess: { pid: 1, startTicks: "1" },
    newProcess: { pid: 2, startTicks: "2" }, afterDigest: "b".repeat(64),
  }, signature: "signature" };
  const receiptSocket = await server(`${JSON.stringify({ receipt })}\n`, 5_200);
  expect(await requestIncusSupervisorReceipt(receiptSocket, "run", "nonce", "b".repeat(64),
    Date.now() + 20_000)).toEqual(receipt);
}, 10_000);

test("client fails closed on missing, denied, malformed, and closed responses", async () => {
  await expect(requestIncusSupervisorRestart("relative.sock", restart)).rejects.toThrow("socket is unavailable");
  await expect(requestIncusSupervisorRestart("/tmp/incus-supervisor-missing.sock", restart))
    .rejects.toThrow();
  const refused = await server('{"accepted":false}\n');
  await expect(requestIncusSupervisorRestart(refused, restart)).rejects.toThrow("refused restart");
  const denied = await server('{"error":"unauthorized control peer"}\n');
  await expect(requestIncusSupervisorReceipt(denied, "run", "nonce", "b".repeat(64),
    Date.now() + 20_000))
    .rejects.toThrow("unauthorized control peer");
  const malformed = await server('invalid\n');
  await expect(requestIncusSupervisorRestart(malformed, restart)).rejects.toThrow("response is invalid");
  const oversized = await server(`${"x".repeat(16385)}\n`);
  await expect(requestIncusSupervisorRestart(oversized, restart)).rejects.toThrow("too large");
  const empty = await server("");
  await expect(requestIncusSupervisorRestart(empty, restart)).rejects.toThrow("closed the response");
  const badReceipt = await server('{"receipt":{}}\n');
  await expect(requestIncusSupervisorReceipt(badReceipt, "run", "nonce", "b".repeat(64),
    Date.now() + 20_000))
    .rejects.toThrow("receipt is invalid");
  const hanging = await server(() => null);
  await expect(requestIncusSupervisorRestart(hanging, restart)).rejects.toThrow("timed out");
}, 10_000);

test("client receipt wait stays inside the run deadline", async () => {
  const hanging = await server(() => null);
  await expect(requestIncusSupervisorReceipt(hanging, "run", "nonce", "b".repeat(64),
    Date.now() + 100)).rejects.toThrow("timed out");
  await expect(requestIncusSupervisorReceipt(hanging, "run", "nonce", "b".repeat(64),
    Date.now() - 1)).rejects.toThrow("deadline expired");
});
