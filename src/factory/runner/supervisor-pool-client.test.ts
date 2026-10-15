/**
 * The supervisor's pool call, over a real mutual-TLS listener.
 *
 * Driven against a real `startFactoryPrivateHttps` rather than a stubbed
 * transport, because what this client adds to the transport is small and the
 * transport is where the mistakes live: a wrong path is a 404 that reads as a
 * refusal, and a body with a field the route does not allow is a 400 that reads
 * the same way. Both are only visible end to end.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFactoryPrivateHttps, type FactoryPrivateRequest } from "../private-https";
import { certificates, type Certificates } from "../../__tests__/helpers/factory-certificates";
import {
  FACTORY_POOL_SUPERVISOR_STOP_PATH,
  FactorySupervisorPoolError,
  createFactorySupervisorPoolClient,
} from "./supervisor-pool-client";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const hostId = "pool-client-host";
const receipt = Object.freeze({ reservationId: "reservation-1", holderGeneration: 3, hostId });

async function secrets(certs: Certificates) {
  const root = await mkdtemp(join(tmpdir(), "factory-supervisor-pool-"));
  directories.push(root);
  const paths = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(paths.caPath, certs.ca);
  await writeFile(paths.certificatePath, certs.clientCert);
  await writeFile(paths.privateKeyPath, certs.clientKey);
  await writeFile(paths.serviceTokenPath, "supervisor-pool-token");
  return paths;
}

/** A pool listener whose one route the test drives directly. */
async function pool(answer: (request: FactoryPrivateRequest) => { status: number; body: unknown }) {
  const certs = await certificates(directories, "supervisor-w09b");
  const seen: FactoryPrivateRequest[] = [];
  const listener = startFactoryPrivateHttps({
    tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
    hostname: "127.0.0.1",
    port: 0,
    maxBodyBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    async handle(request) {
      seen.push(request);
      const { status, body } = answer(request);
      return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) };
    },
  });
  const client = await createFactorySupervisorPoolClient({ hostId, baseUrl: listener.url, serverName: "localhost", tls: await secrets(certs) });
  return { listener, client, seen };
}

const settled = (request: FactoryPrivateRequest) => {
  const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as { reservationId: string; holderGeneration: number };
  return { status: 200, body: { reservationId: body.reservationId, state: "settled", holderGeneration: body.holderGeneration, tenantId: "tenant-a" } };
};

describe("createFactorySupervisorPoolClient", () => {
  test("presents the receipt on the one route a supervisor may call, and nothing else", async () => {
    const { listener, client, seen } = await pool(settled);
    try {
      expect(await client.presentStopReceipt(receipt)).toEqual({ reservationId: "reservation-1", state: "settled", holderGeneration: 3 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: "POST", path: FACTORY_POOL_SUPERVISOR_STOP_PATH, peerIdentity: "supervisor-w09b" });
      // Three fields and no tenant fact: the supervisor route allows exactly
      // these, and a fourth would be a 400 that reads as a refusal.
      expect(JSON.parse(Buffer.from(seen[0]!.body).toString("utf8"))).toEqual({ reservationId: "reservation-1", holderGeneration: 3, hostId });
    } finally { listener.stop(); }
  });

  test("a GPU reservation's `uncertain` is reported, not re-decided", async () => {
    // C03 leaves a GPU host unoffered until a verified reimage receipt lands,
    // so `uncertain` here is the contract rather than a failed call.
    const { listener, client } = await pool((request) => ({ ...settled(request), body: { ...settled(request).body, state: "uncertain" } }));
    try {
      expect((await client.presentStopReceipt(receipt)).state).toBe("uncertain");
    } finally { listener.stop(); }
  });

  test("a refusal carries the pool's status rather than a bare transport error", async () => {
    const { listener, client } = await pool(() => ({ status: 409, body: { error: "conflict" } }));
    try {
      const failure = await client.presentStopReceipt(receipt).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FactorySupervisorPoolError);
      expect(failure).toMatchObject({ code: "factory_supervisor_pool_refused" });
      expect(String((failure as Error).message)).toContain("409");
      expect((failure as { cause?: unknown }).cause).toBeDefined();
    } finally { listener.stop(); }
  });

  test("an answer about another reservation is refused rather than read as success", async () => {
    const { listener, client } = await pool(() => ({ status: 200, body: { reservationId: "reservation-elsewhere", state: "settled", holderGeneration: 3 } }));
    try {
      await expect(client.presentStopReceipt(receipt)).rejects.toMatchObject({ code: "factory_supervisor_pool_refused" });
    } finally { listener.stop(); }
  });

  test("a stale holder generation is refused, because it settles another holder's lease", async () => {
    const { listener, client } = await pool(() => ({ status: 200, body: { reservationId: "reservation-1", state: "settled", holderGeneration: 9 } }));
    try {
      await expect(client.presentStopReceipt(receipt)).rejects.toMatchObject({ code: "factory_supervisor_pool_refused" });
    } finally { listener.stop(); }
  });

  test("a reply that is not a lease status is unreadable, not empty", async () => {
    const { listener, client } = await pool(() => ({ status: 200, body: { ok: true } }));
    try {
      await expect(client.presentStopReceipt(receipt)).rejects.toMatchObject({ code: "factory_supervisor_pool_unreadable" });
    } finally { listener.stop(); }
  });

  test("a reply that is not JSON at all is unreadable too", async () => {
    const certs = await certificates(directories, "supervisor-w09b");
    const listener = startFactoryPrivateHttps({
      tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
      hostname: "127.0.0.1", port: 0, maxBodyBytes: 64 * 1024, maxResponseBytes: 64 * 1024,
      async handle() { return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("not json") }; },
    });
    const client = await createFactorySupervisorPoolClient({ hostId, baseUrl: listener.url, serverName: "localhost", tls: await secrets(certs) });
    try {
      await expect(client.presentStopReceipt(receipt)).rejects.toMatchObject({ code: "factory_supervisor_pool_unreadable" });
    } finally { listener.stop(); }
  });

  test("a receipt for another host never reaches the pool", async () => {
    const { listener, client, seen } = await pool(settled);
    try {
      await expect(client.presentStopReceipt({ ...receipt, hostId: "elsewhere" })).rejects.toMatchObject({ code: "factory_supervisor_pool_host" });
      expect(seen).toEqual([]);
    } finally { listener.stop(); }
  });

  test("a client with no host to speak for refuses to be built", async () => {
    const certs = await certificates(directories, "supervisor-w09b");
    await expect(createFactorySupervisorPoolClient({ hostId: "", baseUrl: "https://127.0.0.1:1", tls: await secrets(certs) }))
      .rejects.toMatchObject({ code: "factory_supervisor_pool_host" });
  });

  test("a transport failure that is not a status reply is raised unchanged", async () => {
    const certs = await certificates(directories, "supervisor-w09b");
    // Nothing is listening, so the transport fails before any status exists.
    const client = await createFactorySupervisorPoolClient({ hostId, baseUrl: "https://127.0.0.1:1", serverName: "localhost", tls: await secrets(certs) });
    const failure = await client.presentStopReceipt(receipt).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(FactorySupervisorPoolError);
  });
});
