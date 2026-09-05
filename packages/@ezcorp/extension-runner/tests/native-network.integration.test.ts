import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, executionLimits, filesDigest } from "../src";
import { provision } from "./helpers";
import { handleNetworkTunnel, closeNetworkTunnels } from "../../../../src/extensions/network-tunnel-broker";
import { handleNetworkBroker } from "../../../../src/extensions/network-broker";
import { handleCredentialBroker } from "../../../../src/extensions/credential-broker";
import { registerCallProvenance, releaseCallProvenance } from "../../../../src/extensions/call-provenance";
import type { RpcHandlerDeps } from "../../../../src/extensions/tool-executor/rpc-handlers";

test("real rootless native MCP uses only the scoped proxy, never direct host sockets", async () => {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("data", bytes => bytes.toString().startsWith("GET /") ? socket.end("HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nnative payload") : socket.write(bytes)); socket.on("error", () => socket.destroy()); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const destination = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const previous = process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS;
  process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS = JSON.stringify([destination]);
  const root = await mkdtemp(join(tmpdir(), "ez-native-proxy-"));
  const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdout: "ignore", stderr: "pipe" });
  expect(await certificate.exited, await new Response(certificate.stderr).text()).toBe(0);
  const tlsServer = createHttpsServer({ key: await Bun.file(join(root, "key.pem")).text(), cert: await Bun.file(join(root, "cert.pem")).text() }, (_request, response) => response.end("native payload"));
  tlsServer.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => tlsServer.listen(0, "127.0.0.1", resolve));
  const tlsDestination = `127.0.0.1:${(tlsServer.address() as { port: number }).port}`;
  process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS = JSON.stringify([destination, tlsDestination]);
  const priorOrigins = process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS;
  process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS = JSON.stringify([`http://${destination}`]);
  const runner = new PodmanRunner({ root, ...await provision() });
  const token = registerCallProvenance({ actorExtensionId: "extension", onBehalfOf: "owner", conversationId: "conversation", runId: null, parentCallId: null, kind: "tool", ownerless: false });
  let granted = true;
  const permissions = { network: ["127.0.0.1"], networkTcp: [destination, tlsDestination], secretRead: ["OPENAI_API_KEY"] };
  const deps = { registry: { getManifest: () => ({ permissions }), getGrantedPermissions: () => granted ? permissions : { secretRead: permissions.secretRead } }, engine: { authorize: async (_context: unknown, needed: { kind: string }[]) => ({ decision: granted || needed.every(capability => capability.kind === "secret.read") ? "allow" : "deny" }) } } as unknown as RpcHandlerDeps;
  try {
    await runner.initialize();
    const manifest = { schemaVersion: 4, name: "native-proxy-test", version: "1.0.0", author: { name: "tests" }, description: "Native network fixture", kind: "mcp", permissions, mcpServers: [{ name: "native", transport: "stdio", command: "/usr/local/bin/bun", args: ["./native.ts"] }] };
    const files = { "native.ts": await Bun.file(new URL("./native-mcp-fixture.ts", import.meta.url)).text(), "extension.ts": `import {createMcpExtension,serve} from '@ezcorp/sdk/v4';await serve(await createMcpExtension({manifest:${JSON.stringify(manifest)}}));`, "metadata.test.ts": `import {test,expect} from 'bun:test';import {validateManifest} from '@ezcorp/extension-contract';test('TCP declaration',()=>expect(validateManifest(${JSON.stringify(manifest)}).permissions.networkTcp).toEqual(${JSON.stringify(permissions.networkTcp)}));` };
    const source = { ...files, "fixture-ca.pem": await Bun.file(join(root, "cert.pem")).text() };
    const result = await runner.build({ operationId: crypto.randomUUID(), files: source, sourceDigest: filesDigest(source), entrypoint: "extension.ts", limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    expect(result.state).toBe("succeeded");
    for (const action of ["direct", "tunnel", "http", "tls", "tls-wrong-host", "credential", "unprivileged", "revoked"] as const) {
      const trace: unknown[] = [];
      const workerId = crypto.randomUUID();
      const context = { invocationId: crypto.randomUUID(), workerId, releaseId: "release", principalId: "owner", scopeId: "conversation", token, deadline: Date.now() + 30_000 };
      if (action === "revoked") granted = false;
      const worker = await runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async (method, params) => {
        const envelope = params as { context: unknown; input: Record<string, unknown> };
        expect(envelope.context).toEqual(context);
        const request = { jsonrpc: "2.0" as const, id: "reverse", method, params: { ...envelope.input, _meta: { ezCallId: token } } };
        const response = method === "ezcorp/credentials.read" ? await handleCredentialBroker(deps, "extension", request, { readRawCredential: async () => action === "unprivileged" ? null : "fixture-approved-token" }) : await (method.startsWith("ezcorp/network.tunnel.") ? handleNetworkTunnel : handleNetworkBroker)(deps, "extension", request);
        trace.push({ method, response: method === "ezcorp/credentials.read" ? "redacted" : response });
        if (response.error) throw new Error(response.error.message);
        return response.result;
      });
      try {
        const invocation = worker.request("extension/invoke", { name: "exchange", input: { action: action === "revoked" ? "tunnel" : action === "unprivileged" ? "credential" : action, destination: action.startsWith("tls") ? tlsDestination : destination }, context });
        if (action === "revoked" || action === "unprivileged" || action === "tls-wrong-host") await expect(invocation).rejects.toThrow();
        else {
          const outcome = await invocation.catch(error => { throw new Error(`${action} failed: ${JSON.stringify(trace)}`, { cause: error }); });
          expect(outcome).toMatchObject({ isError: false, content: [{ type: "text", text: action === "direct" ? "direct denied" : action === "http" ? "HTTP native payload" : action === "tls" ? "TLS native payload" : action === "credential" ? new Bun.CryptoHasher("sha256").update("fixture-approved-token").digest("hex") : "HTTP/1.1 200 Connection Established\r\n\r\nnative payload" }] });
        }
      } finally { await worker.close(); }
    }
  } finally {
    releaseCallProvenance(token);
    closeNetworkTunnels();
    await runner.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => tlsServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS; else process.env.EZCORP_EXTENSION_TCP_INTERNAL_DESTINATIONS = previous;
    if (priorOrigins === undefined) delete process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS; else process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS = priorOrigins;
  }
}, 180_000);
