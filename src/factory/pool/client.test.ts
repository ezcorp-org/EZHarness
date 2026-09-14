import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificates, type Certificates } from "../../__tests__/helpers/factory-certificates";
import { startFactoryPrivateHttps, type FactoryPrivateRequest, type FactoryPrivateResponse } from "../private-https";
import { createPoolAdmissionClient, type PoolAdmissionClient } from "./client";
import type { PoolAdmissionRequest } from "./service";

const directories: string[] = [];
const digestDate = "2030-01-01T00:00:00.000Z";
const request = { reservationId: "reservation/one", grantRevision: 3, grantScope: "tenant-a:run-1", resources: { cpu: 1, memory: 2 }, admissionDeadline: "2029-12-31T23:59:59.000Z", priority: 2, readySequence: 4, nodeId: "node-1" } as const;
const lease = { reservationId: request.reservationId, tenantId: "tenant-a", grantRevision: request.grantRevision, allocationGeneration: 1, holderGeneration: 1, allocationToken: "allocation-token", fence: "lease-fence", deadlineAt: digestDate, resources: request.resources, hostId: "host-1" };
const status = { reservationId: request.reservationId, tenantId: "tenant-a", state: "running", allocationGeneration: 1, holderGeneration: 1, effects: 1, resources: request.resources, hostId: "host-1", reason: "active" };

let client: PoolAdmissionClient;
let server: ReturnType<typeof startFactoryPrivateHttps>;
let override: FactoryPrivateResponse | undefined;
let calls: FactoryPrivateRequest[];
let certs: Certificates;
let tls: { caPath: string; certificatePath: string; privateKeyPath: string; serviceTokenPath: string };

beforeAll(async () => {
  certs = await certificates(directories);
  const directory = directories.at(-1)!;
  const tokenPath = join(directory, "pool-token");
  await writeFile(tokenPath, "pool-client-token", { mode: 0o600 });
  calls = [];
  server = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    async handle(input) {
      calls.push(input);
      if (input.peerIdentity !== "tenant-a" || input.headers.authorization !== "Bearer pool-client-token") return { status: 401, body: Buffer.from("{}") };
      if (override) { const result = override; override = undefined; return result; }
      if (input.method === "GET" && input.path.endsWith("/missing")) return { status: 204, body: Buffer.alloc(0) };
      if (input.method === "GET") return { status: 200, body: Buffer.from(JSON.stringify(status)) };
      if (input.path.endsWith("/cancel")) return { status: 200, body: Buffer.from(JSON.stringify({ ...status, state: "revoking", allocationGeneration: 2, reason: "cancelled" })) };
      if (input.path.includes("/acknowledge-start") || input.path.endsWith("/renew")) return { status: 200, body: Buffer.from(JSON.stringify(lease)) };
      return { status: 200, body: Buffer.from(JSON.stringify({ status: "admitted", reservationId: request.reservationId, lease })) };
    },
  });
  tls = { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: tokenPath };
  client = await createPoolAdmissionClient({ tenantId: "tenant-a", baseUrl: server.url, serverName: "localhost", requestTimeoutMs: 2_000, tls });
});

afterAll(async () => { server?.stop(); await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

describe("pool admission HTTP client", () => {
  test("uses only fixed encoded routes and converts exact lease dates", async () => {
    const admitted = await client.request(request);
    expect(admitted.status).toBe("admitted");
    expect(admitted.lease?.deadlineAt).toEqual(new Date(digestDate));
    expect(calls.at(-1)?.path).toBe("/v1/pool/requests");
    expect(JSON.parse(calls.at(-1)!.body.toString())).toEqual(request);

    expect(await client.status("missing")).toBeUndefined();
    expect((await client.status(request.reservationId))?.state).toBe("running");
    expect(calls.at(-1)?.path).toContain("reservation%2Fone");

    const fence = { reservationId: request.reservationId, grantRevision: 3, allocationGeneration: 1, allocationToken: "allocation-token" };
    expect((await client.acknowledgeStart(fence)).allocationGeneration).toBe(1);
    expect((await client.renew(fence)).deadlineAt).toEqual(new Date(digestDate));
    expect((await client.cancel(request.reservationId, 1)).allocationGeneration).toBe(2);
    expect(JSON.parse(calls.at(-1)!.body.toString())).toEqual({ allocationGeneration: 1 });
  });

  test("returns every non-admitted decision without inventing a lease", async () => {
    for (const decision of [
      { status: "queued", reservationId: request.reservationId, queueAgeMs: 4, blockingResource: "cpu" },
      { status: "rejected", reservationId: request.reservationId, reason: "queue-full", retryAfterSeconds: 1 },
      { status: "cancelled", reservationId: request.reservationId, reason: "cancelled-before-admission" },
    ] as const) {
      override = { status: 200, body: Buffer.from(JSON.stringify(decision)) };
      const result = await client.request(request);
      expect(result).toEqual(decision);
      expect(result.lease).toBeUndefined();
    }
  });

  test("rejects malformed or mismatched replies and never retries a failed mutation", async () => {
    const bad = [
      Buffer.from("{"),
      Buffer.from(JSON.stringify({ status: "unknown", reservationId: request.reservationId })),
      Buffer.from(JSON.stringify({ status: "queued", reservationId: "other" })),
      Buffer.from(JSON.stringify({ status: "admitted", reservationId: request.reservationId, lease: { ...lease, tenantId: "other" } })),
      Buffer.from(JSON.stringify({ status: "admitted", reservationId: request.reservationId, lease: { ...lease, grantRevision: 4 } })),
      Buffer.from(JSON.stringify({ status: "admitted", reservationId: request.reservationId, lease: { ...lease, allocationGeneration: 0 } })),
      Buffer.from(JSON.stringify({ status: "admitted", reservationId: request.reservationId, lease: { ...lease, deadlineAt: "+010000-01-01T00:00:00.000Z" } })),
      Buffer.from(JSON.stringify({ status: "admitted", reservationId: request.reservationId, lease: { ...lease, resources: { cpu: 2, memory: 2 } } })),
      Buffer.from(JSON.stringify({ status: "queued", reservationId: request.reservationId, extra: true })),
    ];
    for (const body of bad) {
      override = { status: 200, body };
      await expect(client.request(request)).rejects.toThrow();
    }
    const before = calls.length;
    override = { status: 500, body: Buffer.from('{"error":"failed"}') };
    await expect(client.request(request)).rejects.toThrow("HTTP 500");
    expect(calls.length).toBe(before + 1);
  });

  test("returns the queue-full decision carried by HTTP 429 and fails closed elsewhere", async () => {
    const full = { status: "rejected", reservationId: request.reservationId, reason: "queue-full", retryAfterSeconds: 1 } as const;
    override = { status: 429, body: Buffer.from(JSON.stringify(full)) };
    expect(await client.request(request)).toEqual(full);

    // Only an admission start decodes 429. Every other route keeps failing closed.
    override = { status: 429, body: Buffer.from(JSON.stringify(full)) };
    await expect(client.status(request.reservationId)).rejects.toThrow("HTTP 429");

    override = { status: 429, body: Buffer.from(JSON.stringify({ status: "rejected", reservationId: request.reservationId, reason: "request-exceeds-configured-capacity" })) };
    await expect(client.request(request)).rejects.toThrow("unexpected queue-full");
    override = { status: 429, body: Buffer.from(JSON.stringify({ ...full, reservationId: "other" })) };
    await expect(client.request(request)).rejects.toThrow("mismatched reservation");

    const before = calls.length;
    const controller = new AbortController();
    controller.abort();
    await expect(client.request(request, controller.signal)).rejects.toThrow();
    expect(calls.length).toBe(before);
  });

  test("prefers a Retry-After delta-seconds header over the decision body", async () => {
    const full = { status: "rejected", reservationId: request.reservationId, reason: "queue-full", retryAfterSeconds: 1 } as const;
    let retryAfter: string | undefined;
    const headers = new Headers({ "content-type": "application/json" });
    const headerServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: certs.serverKey, cert: certs.serverCert },
      fetch() {
        const value = new Headers(headers);
        if (retryAfter !== undefined) value.set("retry-after", retryAfter);
        return new Response(JSON.stringify(full), { status: 429, headers: value });
      },
    });
    try {
      const headerClient = await createPoolAdmissionClient({ tenantId: "tenant-a", baseUrl: headerServer.url.href, serverName: "localhost", requestTimeoutMs: 2_000, tls });
      for (const [header, expected] of [[undefined, 1], ["45", 45], [" 7 ", 7], ["0", 1], ["not-a-number", 1], ["Wed, 21 Oct 2026 07:28:00 GMT", 1], ["1234567", 1]] as const) {
        retryAfter = header;
        expect(await headerClient.request(request)).toEqual({ ...full, retryAfterSeconds: expected });
      }
    } finally { headerServer.stop(true); }
  });

  test("validates caller input before transport and snapshots it before an await", async () => {
    const invalid = [
      { ...request, reservationId: "" },
      { ...request, grantRevision: 0 },
      { ...request, resources: {} },
      { ...request, resources: { cpu: 1_000_001 } },
      { ...request, admissionDeadline: "2030-01-01" },
      { ...request, extra: true },
    ];
    const before = calls.length;
    for (const value of invalid) await expect(client.request(value as never)).rejects.toThrow();
    expect(calls.length).toBe(before);

    const mutable: PoolAdmissionRequest = { ...request, resources: { ...request.resources } };
    const pending = client.request(mutable);
    mutable.reservationId = "changed";
    (mutable.resources as { cpu: number }).cpu = 9;
    expect((await pending).reservationId).toBe(request.reservationId);
    expect(JSON.parse(calls.at(-1)!.body.toString()).resources.cpu).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(client.status("missing", controller.signal)).rejects.toThrow();
  });

  test("rejects malformed and mismatched status, lease, and cancellation replies", async () => {
    override = { status: 200, body: Buffer.from(JSON.stringify({ ...status, tenantId: "foreign" })) };
    await expect(client.status(request.reservationId)).rejects.toThrow("mismatched status");
    override = { status: 200, body: Buffer.from(JSON.stringify({ ...lease, reservationId: "foreign" })) };
    await expect(client.renew({ reservationId: request.reservationId, grantRevision: 3, allocationGeneration: 1, allocationToken: "allocation-token" })).rejects.toThrow("mismatched lease");
    override = { status: 200, body: Buffer.from(JSON.stringify({ ...status, allocationGeneration: 0 })) };
    await expect(client.cancel(request.reservationId, 1)).rejects.toThrow();
  });
});
