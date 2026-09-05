import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { startNativeProxy } from "../../../packages/@ezcorp/sdk/src/v4/native-proxy";
import { closeNetworkTunnels, handleNetworkTunnel } from "../network-tunnel-broker";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { grantsToCapabilitySet, intersectPermissions, isSubset } from "../capability-types";
import { buildFullGrantFromManifest } from "../install-grant";
import { clampExtensionPermissions } from "../clamp-permissions";
import type { RpcHandlerDeps } from "../tool-executor/rpc-handlers";
import type { JsonRpcRequest } from "../types";

const tokens: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  closeNetworkTunnels();
  for (const token of tokens.splice(0)) releaseCallProvenance(token);
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  delete process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS;
});

async function fixture() {
  const server = createServer(socket => { sockets.add(socket); socket.on("error", () => socket.destroy()); socket.on("data", bytes => socket.write(bytes)); socket.once("close", () => sockets.delete(socket)); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const destination = `127.0.0.1:${address.port}`;
  const token = registerCallProvenance({ actorExtensionId: "extension", onBehalfOf: "owner", conversationId: "conversation", runId: null, parentCallId: null, kind: "tool", ownerless: false });
  tokens.push(token);
  const state = { declared: true, granted: true, allowed: true };
  const deps = { registry: { getManifest: () => ({ permissions: { networkTcp: state.declared ? [destination] : [] } }), getGrantedPermissions: () => ({ networkTcp: state.granted ? [destination] : [] }) }, engine: { authorize: async (_context: unknown, needed: unknown) => { expect(needed).toEqual([{ kind: "network.tcp", value: destination }]); return { decision: state.allowed ? "allow" : "deny" }; } } } as unknown as RpcHandlerDeps;
  const request = (method: string, input: Record<string, unknown> = {}, identity = token): JsonRpcRequest => ({ jsonrpc: "2.0", id: "request", method: `ezcorp/network.tunnel.${method}`, params: { ...input, _meta: { ezCallId: identity } } });
  const call = (method: string, input: Record<string, unknown> = {}) => handleNetworkTunnel(deps, "extension", request(method, input));
  process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS = JSON.stringify([destination]);
  const open = async () => { const result = await call("open", { destination }); expect(result.error).toBeUndefined(); return (result.result as { tunnelId: string }).tunnelId; };
  return { destination, token, state, deps, request, call, open };
}

test("real pinned TCP connection exchanges bounded ordered chunks and closes", async () => {
  const value = await fixture();
  const tunnelId = await value.open();
  expect(await value.call("write", { tunnelId, sequence: 0, data: Buffer.from("real socket payload").toString("base64") })).toMatchObject({ result: { sequence: 0 } });
  const result = await value.call("read", { tunnelId, sequence: 0 });
  expect(result.error).toBeUndefined();
  expect(Buffer.from((result.result as { data: string }).data, "base64").toString()).toBe("real socket payload");
  expect(await value.call("close", { tunnelId })).toMatchObject({ result: { closed: true } });
  expect((await value.call("read", { tunnelId, sequence: 1 })).error).toBeDefined();
});

test("native CONNECT proxy relays real bytes through the invocation broker and closes on revocation", async () => {
  const value = await fixture();
  const controller = new AbortController();
  const proxy = await startNativeProxy({ signal: controller.signal, invocation: { invocationId: "native", workerId: "worker", releaseId: "release", principalId: "owner", scopeId: "conversation", token: value.token, deadline: Date.now() + 10_000 }, call: async (method, input) => {
    const response = await handleNetworkTunnel(value.deps, "extension", { ...value.request("open", input as Record<string, unknown>), method });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  } });
  const endpoint = new URL(proxy.environment.HTTPS_PROXY!);
  const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
  sockets.add(socket);
  socket.on("error", () => socket.destroy());
  try {
    let received = "";
    const echoed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CONNECT exchange timed out: ${received}`)), 3000);
      socket.on("data", bytes => {
        received += bytes.toString();
        if (received === "HTTP/1.1 200 Connection Established\r\n\r\n") socket.write("real native tunnel");
        if (received.includes("real native tunnel")) { clearTimeout(timer); resolve(); }
      });
    });
    socket.write(`CONNECT ${value.destination} HTTP/1.1\r\nHost: ${value.destination}\r\nProxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}\r\n\r\n`);
    await echoed;
    expect(received).toBe("HTTP/1.1 200 Connection Established\r\n\r\nreal native tunnel");
    const closed = new Promise<void>(resolve => socket.once("close", resolve));
    value.state.granted = false;
    await closed;
    expect(socket.destroyed).toBe(true);
  } finally { controller.abort(); await proxy.close(); }
}, 10_000);

test("an HTTP grant is never a TCP grant and intersection retains exact destinations only", () => {
  const needed = [{ kind: "network.tcp" as const, value: "example.com:443" }];
  expect(isSubset(needed, grantsToCapabilitySet({ network: ["example.com"], grantedAt: {} }, "owner"))).toBe(false);
  expect(isSubset(needed, grantsToCapabilitySet({ networkTcp: ["example.com:443"], grantedAt: {} }, "owner"))).toBe(true);
  expect(intersectPermissions({ networkTcp: ["example.com:443", "example.com:8443"], grantedAt: { networkTcp: 10 } }, { networkTcp: ["example.com:443"], grantedAt: { networkTcp: 20 } })).toMatchObject({ networkTcp: ["example.com:443"], grantedAt: { networkTcp: 10 } });
  const permissions = { networkTcp: ["example.com:443"], secretRead: ["GITHUB_TOKEN"] };
  expect(buildFullGrantFromManifest({ schemaVersion: 4, name: "fixture", version: "1.0.0", author: { name: "tests" }, description: "Fixture", permissions }, 123)).toMatchObject({ ...permissions, grantedAt: { networkTcp: 123, secretRead: 123 } });
  expect(clampExtensionPermissions({ networkTcp: ["example.com:443", "example.com:8443"], secretRead: ["GITHUB_TOKEN", "DATABASE_URL"] }, permissions)).toMatchObject(permissions);
  expect(clampExtensionPermissions(permissions, {})).toEqual({ grantedAt: {} });
});

test("private TCP needs both an exact configured IP exception and live release grant", async () => {
  const value = await fixture();
  delete process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS;
  expect((await value.call("open", { destination: value.destination })).error).toBeDefined();
  process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS = JSON.stringify([value.destination]);
  for (const key of ["declared", "granted", "allowed"] as const) {
    value.state[key] = false;
    expect((await value.call("open", { destination: value.destination })).error).toBeDefined();
    value.state[key] = true;
  }
  for (const invalid of ["[]", '["169.254.169.254:80"]', '["example.com:443"]', '{}']) {
    process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS = invalid;
    expect((await value.call("open", { destination: value.destination })).error).toBeDefined();
  }
});

test("DNS cannot redirect a declared public destination onto a private service", async () => {
  const value = await fixture();
  const deps = { ...value.deps, registry: { getManifest: () => ({ permissions: { networkTcp: ["example.com:443"] } }), getGrantedPermissions: () => ({ networkTcp: ["example.com:443"] }) }, engine: { authorize: async () => ({ decision: "allow" }) } } as unknown as RpcHandlerDeps;
  for (const addresses of [["127.0.0.1"], ["169.254.169.254"], ["::1"], ["93.184.216.34", "10.0.0.1"], []]) expect((await handleNetworkTunnel(deps, "extension", value.request("open", { destination: "example.com:443" }), { resolveHost: async () => addresses })).error).toBeDefined();
});

test("another invocation cannot use or close a handle and revocation closes active sockets", async () => {
  const value = await fixture();
  const other = await fixture();
  process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS = JSON.stringify([value.destination, other.destination]);
  const tunnelId = await value.open();
  expect((await handleNetworkTunnel(value.deps, "extension", value.request("close", { tunnelId }, other.token))).error).toBeDefined();
  expect((await value.call("write", { tunnelId, sequence: 0, data: "eA==" })).error).toBeUndefined();
  value.state.allowed = false;
  await Bun.sleep(350);
  expect((await value.call("read", { tunnelId, sequence: 0 })).error).toBeDefined();
  value.state.allowed = true;
  const cancelled = await value.open();
  releaseCallProvenance(value.token);
  await Bun.sleep(350);
  expect((await value.call("read", { tunnelId: cancelled, sequence: 0 })).error).toBeDefined();
});

test("invalid chunk sequences close only the caller's connection and capacity is bounded", async () => {
  const value = await fixture();
  for (const request of [{ sequence: 1, data: "eA==" }, { sequence: 0, data: "Zh==" }, { sequence: 0, data: "" }]) {
    const tunnelId = await value.open();
    expect((await value.call("write", { tunnelId, ...request })).error).toBeDefined();
    expect((await value.call("read", { tunnelId, sequence: 0 })).error).toBeDefined();
  }
  const ids = [];
  for (let index = 0; index < 4; index++) ids.push(await value.open());
  expect((await value.call("open", { destination: value.destination })).error).toBeDefined();
  for (const tunnelId of ids) expect((await value.call("close", { tunnelId })).error).toBeUndefined();
});

test("aggregate duplex byte budget closes a real connection without retrying an extra write", async () => {
  const value = await fixture();
  const tunnelId = await value.open();
  const chunk = Buffer.alloc(64 * 1024, 42).toString("base64");
  let readSequence = 0;
  for (let sequence = 0; sequence < 256; sequence++) {
    expect((await value.call("write", { tunnelId, sequence, data: chunk })).error).toBeUndefined();
    let received = 0;
    while (received < 64 * 1024) {
      const result = await value.call("read", { tunnelId, sequence: readSequence++ });
      expect(result.error).toBeUndefined();
      received += Buffer.from((result.result as { data: string }).data, "base64").length;
    }
  }
  const denied = await value.call("write", { tunnelId, sequence: 256, data: "eA==" });
  expect(denied.error).toMatchObject({ data: { retryable: false } });
  expect((await value.call("close", { tunnelId })).error).toBeDefined();
}, 30_000);

test("a stalled policy check cannot leave an unbounded pending connection", async () => {
  const value = await fixture();
  const deps = { ...value.deps, engine: { authorize: () => new Promise(() => undefined) } } as unknown as RpcHandlerDeps;
  const started = performance.now();
  expect((await handleNetworkTunnel(deps, "extension", value.request("open", { destination: value.destination }))).error).toBeDefined();
  expect(performance.now() - started).toBeLessThan(6000);
}, 7000);
