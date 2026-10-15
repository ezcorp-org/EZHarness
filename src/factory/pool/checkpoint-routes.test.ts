import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { FactoryPrivateRequest } from "../private-https";
import type { PoolAdmissionService } from "./service";
import { createPoolAdmissionRouteHandler } from "./service-routes";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(scopes = ["pool:tenant:tenant-01", "pool:restore:tenant-01"]): string {
  const input = `${encode({ alg: "RS256", kid: "test" })}.${encode({ sub: "tenant-one", iss: "factory-test", aud: "factory-pool", exp: Math.floor(Date.now() / 1_000) + 60, scope: scopes })}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(keys.privateKey).toString("base64url")}`;
}

const page = { position: "0/1", rows: [{ reservation_id: "r-1", tenant_id: "tenant-01", state: "running" }], next: null };
const service = {
  checkpoint: mock(async () => page),
  restoreImport: mock(async () => ({ present: ["r-1"], imported: ["r-2"], overcommitted: [] })),
  acquireCheckpointSlot: mock(async () => ({ slot: 3, token: "slot-token", expiresAt: "2026-09-22T00:00:15.000Z" })),
  releaseCheckpointSlot: mock(async () => true),
} as unknown as PoolAdmissionService;
const identities = { tenants: { "tenant-one": { tenantId: "tenant-01", tokenSubject: "tenant-one" } }, supervisors: {} };
const handler = createPoolAdmissionRouteHandler({ identities, tokens: { issuer: "factory-test", audience: "factory-pool", publicKeys: { test: keys.publicKey.export({ type: "pkcs1", format: "pem" }).toString() } }, service });

function request(path: string, body: unknown): FactoryPrivateRequest {
  return { peerIdentity: "tenant-one", method: "POST", path, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "x-ezcorp-factory-version": "1" }, body: Buffer.from(JSON.stringify(body)) };
}
const answer = async (value: Promise<{ status: number; body: Uint8Array }>) => { const result = await value; return { status: result.status, body: JSON.parse(Buffer.from(result.body).toString()) }; };

beforeEach(() => { for (const value of Object.values(service as unknown as Record<string, ReturnType<typeof mock>>)) value.mockClear(); });

describe("the pool's C06 checkpoint routes", () => {
  test("a tenant reads its own checkpoint pages, from the start or after a cursor", async () => {
    expect(await answer(handler(request("/v1/pool/checkpoint", { after: null })))).toEqual({ status: 200, body: page });
    expect(service.checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "tenant", tenantId: "tenant-01" }), null);
    await handler(request("/v1/pool/checkpoint", {}));
    expect(service.checkpoint).toHaveBeenLastCalledWith(expect.anything(), null);
    await handler(request("/v1/pool/checkpoint", { after: "r-1" }));
    expect(service.checkpoint).toHaveBeenLastCalledWith(expect.anything(), "r-1");
    expect((await answer(handler(request("/v1/pool/checkpoint", { after: "r-1", extra: true })))).status).toBe(400);
  });

  test("a tenant acquires and releases its own barrier slot", async () => {
    expect(await answer(handler(request("/v1/pool/checkpoint-slot", {})))).toEqual({ status: 200, body: { slot: { slot: 3, token: "slot-token", expiresAt: "2026-09-22T00:00:15.000Z" } } });
    expect(service.acquireCheckpointSlot).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "tenant", tenantId: "tenant-01" }));
    expect((await answer(handler(request("/v1/pool/checkpoint-slot", { tenantId: "tenant-02" })))).status).toBe(400);
    expect(await answer(handler(request("/v1/pool/checkpoint-slot/release", { token: "slot-token" })))).toEqual({ status: 200, body: { released: true } });
    expect(service.releaseCheckpointSlot).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: "tenant-01" }), "slot-token");
    for (const body of [{}, { token: "" }, { token: "t", extra: 1 }]) expect((await answer(handler(request("/v1/pool/checkpoint-slot/release", body)))).status).toBe(400);
  });

  test("a restore import is bounded and every row must be an object", async () => {
    expect(await answer(handler(request("/v1/pool/restore-import", { rows: [{ reservation_id: "r-2" }] })))).toEqual({ status: 200, body: { present: ["r-1"], imported: ["r-2"], overcommitted: [] } });
    expect(service.restoreImport).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: "tenant-01" }), [{ reservation_id: "r-2" }]);
    for (const body of [{ rows: "no" }, { rows: Array.from({ length: 65 }, () => ({})) }, { rows: ["string"] }, { rows: [] , extra: 1 }]) {
      expect((await answer(handler(request("/v1/pool/restore-import", body)))).status).toBe(400);
    }
  });
});
