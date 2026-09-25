/**
 * The shared gateway transport settles every request under Bun.
 *
 * Bun's `node:https` emits only `close` when a request is destroyed or aborted,
 * never `error`, so a transport that rejects from the `error` event alone leaves
 * the caller waiting for ever (W01h). The product process runs under Bun, which
 * is why this suite runs there and imports the package source: the Node suite
 * of the orchestrator package cannot see this runtime's behaviour.
 */
import { afterAll, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGatewayTransport } from "../../packages/@ezcorp/factory-transport/src/index";
import { certificates } from "./helpers/factory-certificates";
import { startFactoryPrivateHttps, type FactoryPrivateResponse } from "../factory/private-https";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

/** A private server whose answers the test releases, so nothing here waits on a clock it does not control. */
async function server(respond: (path: string) => FactoryPrivateResponse | "hold") {
  const certs = await certificates(directories);
  const directory = directories.at(-1)!;
  const tokenPath = join(directory, "service-token");
  await writeFile(tokenPath, "fixture-service-token", { mode: 0o600 });
  const held: Array<() => void> = [];
  let arrived = 0;
  const started = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    async handle(request) {
      arrived += 1;
      const answer = respond(request.path);
      if (answer !== "hold") return answer;
      await new Promise<void>(resolve => held.push(resolve));
      return { status: 200, body: Buffer.from("{}") };
    },
  });
  const tls = { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: tokenPath };
  return {
    tls,
    url: started.url,
    arrived: () => arrived,
    close: () => { for (const release of held.splice(0)) release(); started.stop(); },
  };
}

test("a request the peer never answers rejects at its own deadline", async () => {
  const peer = await server(() => "hold");
  try {
    const client = await createGatewayTransport({ baseUrl: peer.url, tls: peer.tls, serverName: "localhost", requestTimeoutMs: 200 });
    await expect(client.request("POST", "/v1/hold", {})).rejects.toThrow("factory gateway request timed out");
    expect(peer.arrived()).toBe(1);
  } finally { peer.close(); }
});

test("an aborted request rejects with the signal's reason, and a reasonless abort is named", async () => {
  const peer = await server(() => "hold");
  try {
    const client = await createGatewayTransport({ baseUrl: peer.url, tls: peer.tls, serverName: "localhost", requestTimeoutMs: 30_000 });
    const withReason = new AbortController();
    const first = client.request("POST", "/v1/hold", {}, undefined, withReason.signal);
    while (peer.arrived() < 1) await Bun.sleep(5);
    withReason.abort(new Error("the caller stopped waiting"));
    await expect(first).rejects.toThrow("the caller stopped waiting");

    const withoutReason = new AbortController();
    const second = client.request("POST", "/v1/hold", {}, undefined, withoutReason.signal);
    while (peer.arrived() < 2) await Bun.sleep(5);
    withoutReason.abort("not an error");
    await expect(second).rejects.toThrow("factory gateway request aborted");
  } finally { peer.close(); }
});

test("a response larger than the caller's limit rejects instead of hanging", async () => {
  const peer = await server(() => ({ status: 200, body: Buffer.alloc(64 * 1024, 120) }));
  try {
    const client = await createGatewayTransport({ baseUrl: peer.url, tls: peer.tls, serverName: "localhost", requestTimeoutMs: 30_000 });
    await expect(client.request("POST", "/v1/large", {}, 1_024)).rejects.toThrow("factory gateway response exceeds 1024 bytes");
  } finally { peer.close(); }
});

test("a settled request leaves no listener on a long-lived signal", async () => {
  const peer = await server(() => ({ status: 200, body: Buffer.from("{\"ok\":true}") }));
  try {
    const client = await createGatewayTransport({ baseUrl: peer.url, tls: peer.tls, serverName: "localhost", requestTimeoutMs: 30_000 });
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => { if (args[0] === "abort") added += 1; return add(...args); }) as AbortSignal["addEventListener"];
    controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => { if (args[0] === "abort") removed += 1; return remove(...args); }) as AbortSignal["removeEventListener"];
    for (let index = 0; index < 3; index += 1) {
      const response = await client.request("POST", "/v1/ok", {}, undefined, controller.signal);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({ ok: true });
    }
    // Each request's own close handler detaches the listener it added. The
    // runtime may add its own for the `signal` option; that one is not ours.
    while (removed < 3) await Bun.sleep(5);
    expect(removed).toBe(3);
    expect(added).toBeGreaterThanOrEqual(3);
  } finally { peer.close(); }
});
