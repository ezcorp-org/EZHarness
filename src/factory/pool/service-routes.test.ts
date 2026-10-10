import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { FactoryPrivateRequest } from "../private-https";
import type { PoolAdmissionService } from "./service";
import { createPoolAdmissionRouteHandler } from "./service-routes";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(subject = "tenant-one", scopes = ["pool:tenant:tenant-01", "pool:grant:tenant-01:grant-a"]): string {
  const input = `${encode({ alg: "RS256", kid: "test" })}.${encode({ sub: subject, iss: "factory-test", aud: "factory-pool", exp: Math.floor(Date.now() / 1_000) + 60, scope: scopes })}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(keys.privateKey).toString("base64url")}`;
}

const lease = { reservationId: "reservation/one", tenantId: "tenant-01", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "token", fence: "fence", deadlineAt: new Date("2030-01-01T00:00:00.000Z"), resources: { cpu: 1 } };
const running = { reservationId: lease.reservationId, tenantId: lease.tenantId, state: "running", allocationGeneration: 1, holderGeneration: 1, effects: 1, resources: { cpu: 1 } };
const service = {
  setup: mock(async () => {}),
  request: mock(async () => ({ status: "queued", reservationId: lease.reservationId })),
  status: mock(async (_principal, reservationId) => reservationId === "missing" ? undefined : running),
  acknowledgeStart: mock(async () => lease),
  renew: mock(async () => lease),
  cancel: mock(async () => ({ ...running, state: "revoking", allocationGeneration: 2 })),
  confirmStopped: mock(async () => ({ ...running, state: "uncertain" })),
  confirmReimage: mock(async () => ({ ...running, state: "settled" })),
} as unknown as PoolAdmissionService;

const identities = { tenants: { "tenant-one": { tenantId: "tenant-01", tokenSubject: "tenant-one" } }, supervisors: { "supervisor-one": { supervisorId: "supervisor-a", tokenSubject: "supervisor-one", hostIds: ["gpu-a"] } } };
const options = { identities, tokens: { issuer: "factory-test", audience: "factory-pool", publicKeys: { test: keys.publicKey.export({ type: "pkcs1", format: "pem" }).toString() } }, service };
const handler = createPoolAdmissionRouteHandler(options);

function request(method: string, path: string, body?: unknown, overrides: Partial<FactoryPrivateRequest> = {}): FactoryPrivateRequest {
  return {
    peerIdentity: "tenant-one",
    method,
    path,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json; charset=utf-8", "x-ezcorp-factory-version": "1" },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
    ...overrides,
  };
}

const admission = { reservationId: lease.reservationId, grantRevision: 1, grantScope: "tenant-01:grant-a", resources: { cpu: 1 }, admissionDeadline: "2030-01-01T00:00:00.000Z", priority: 1, readySequence: 2, nodeId: "node-1" };
const fence = { grantRevision: 1, allocationGeneration: 1, allocationToken: "token" };
const response = async (value: Promise<{ status: number; body: Uint8Array }>) => { const result = await value; return { status: result.status, body: result.body.byteLength ? JSON.parse(Buffer.from(result.body).toString()) : undefined }; };

beforeEach(() => {
  for (const value of Object.values(service as unknown as Record<string, ReturnType<typeof mock>>)) value.mockClear?.();
});

describe("shared pool admission routes", () => {
  test("routes every tenant operation with canonical decoded reservation identity", async () => {
    expect(await response(handler(request("POST", "/v1/pool/requests", admission)))).toEqual({ status: 200, body: { status: "queued", reservationId: lease.reservationId } });
    expect(service.request).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-01" }), admission);

    expect((await response(handler(request("GET", "/v1/pool/requests/reservation%2Fone")))).body.state).toBe("running");
    expect(service.status).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-01" }), lease.reservationId);
    expect(await response(handler(request("GET", "/v1/pool/requests/missing")))).toEqual({ status: 204, body: undefined });

    expect((await response(handler(request("POST", "/v1/pool/requests/reservation%2Fone/acknowledge-start", fence)))).body.deadlineAt).toBe("2030-01-01T00:00:00.000Z");
    expect((await response(handler(request("POST", "/v1/pool/requests/reservation%2Fone/renew", fence)))).status).toBe(200);
    expect((await response(handler(request("POST", "/v1/pool/requests/reservation%2Fone/cancel", { allocationGeneration: 1 })))).body.allocationGeneration).toBe(2);
    expect(service.cancel).toHaveBeenCalledWith(expect.anything(), lease.reservationId, 1);
  });

  test("routes supervisor stop and reimage only under its configured identity", async () => {
    const supervisor = { peerIdentity: "supervisor-one", headers: { authorization: `Bearer ${token("supervisor-one", ["pool:supervisor:supervisor-a"])}`, "content-type": "application/json", "x-ezcorp-factory-version": "1" } };
    const stop = { reservationId: lease.reservationId, holderGeneration: 1, hostId: "gpu-a" };
    expect((await response(handler(request("POST", "/v1/pool/supervisor/stop", stop, supervisor)))).body.state).toBe("uncertain");
    expect((await response(handler(request("POST", "/v1/pool/supervisor/reimage", { ...stop, receipt: "receipt-1" }, supervisor)))).body.state).toBe("settled");
    expect(service.confirmReimage).toHaveBeenCalledWith(expect.objectContaining({ kind: "supervisor" }), { ...stop, receipt: "receipt-1" });
  });

  test("fails closed on authentication, version, framing, shape, and noncanonical paths", async () => {
    const cases: Array<[FactoryPrivateRequest, number]> = [
      [request("GET", "/v1/pool/requests/missing", undefined, { headers: {} }), 401],
      [request("GET", "/v1/pool/requests/missing", undefined, { headers: { authorization: "Bearer bad", "x-ezcorp-factory-version": "1" } }), 401],
      [request("GET", "/v1/pool/requests/missing", undefined, { headers: { authorization: `Bearer ${token()}` } }), 400],
      [request("POST", "/v1/pool/requests", admission, { headers: { authorization: `Bearer ${token()}`, "x-ezcorp-factory-version": "1" } }), 400],
      [request("POST", "/v1/pool/requests", admission, { body: Buffer.from("{") }), 400],
      [request("POST", "/v1/pool/requests", { ...admission, extra: true }), 400],
      [request("GET", "/v1/pool/requests/reservation%2fone"), 400],
      [request("GET", "/v1/pool/requests/%"), 400],
      [request("GET", "/v1/pool/requests/missing?extra=1"), 400],
      [request("GET", "//foreign.invalid/v1/pool/requests/missing"), 400],
      [request("GET", "/not-found"), 404],
    ];
    for (const [input, expected] of cases) expect({ path: input.path, status: (await handler(input)).status }).toEqual({ path: input.path, status: expected });
  });

  test("maps service denial, absence, conflict, invalid input, and failure without leaking details", async () => {
    for (const [message, status, code] of [
      ["Pool lease is fenced.", 409, "conflict"],
      ["Pool reservation does not exist.", 404, "not_found"],
      ["Pool token scope is denied.", 403, "forbidden"],
      ["Pool value is malformed.", 400, "invalid_request"],
      ["Pool resource class is unsupported.", 400, "invalid_request"],
      ["database unavailable", 500, "request_failed"],
    ] as const) {
      (service.status as ReturnType<typeof mock>).mockRejectedValueOnce(new Error(message));
      expect(await response(handler(request("GET", "/v1/pool/requests/known")))).toEqual({ status, body: { error: code } });
    }
  });

  test("answers a full admission queue with HTTP 429 and leaves every other decision at 200", async () => {
    const full = { status: "rejected", reservationId: lease.reservationId, reason: "queue-full", retryAfterSeconds: 1 };
    const start = () => response(handler(request("POST", "/v1/pool/requests", admission)));
    (service.request as ReturnType<typeof mock>).mockResolvedValueOnce(full);
    // The retry interval travels in the body: the private HTTPS response
    // carries no headers, so `Retry-After` itself waits on the W09 seam.
    expect(await start()).toEqual({ status: 429, body: full });

    for (let index = 0; index < 8; index += 1) (service.request as ReturnType<typeof mock>).mockResolvedValueOnce(full);
    expect((await Promise.all(Array.from({ length: 8 }, start))).map(value => value.status)).toEqual(Array.from({ length: 8 }, () => 429));

    for (const other of [
      { status: "rejected", reservationId: lease.reservationId, reason: "request-exceeds-configured-capacity" },
      { status: "queued", reservationId: lease.reservationId, queueAgeMs: 0, blockingResource: "cpu" },
    ]) {
      (service.request as ReturnType<typeof mock>).mockResolvedValueOnce(other);
      expect(await start()).toEqual({ status: 200, body: other });
    }

    (service.request as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Pool grant scope is not owned by the tenant."));
    expect(await start()).toEqual({ status: 403, body: { error: "forbidden" } });
  });

  test("bounds service replies and snapshots certificate and token configuration", async () => {
    (service.request as ReturnType<typeof mock>).mockResolvedValueOnce({ status: "rejected", reservationId: lease.reservationId, reason: "x".repeat(20_000) });
    expect(await response(handler(request("POST", "/v1/pool/requests", admission)))).toEqual({ status: 500, body: { error: "request_failed" } });
    const original = identities.tenants["tenant-one"];
    delete (identities.tenants as Record<string, unknown>)["tenant-one"];
    expect((await handler(request("GET", "/v1/pool/requests/missing"))).status).toBe(204);
    identities.tenants["tenant-one"] = original;
  });
});
