import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTP_READ_PREFIX, authorize, authorizeRead, handle, readRevocations, readTokenFrom } from "./factory-temporal-authorizer.mjs";

const token = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;
const headers = (claims: Record<string, unknown>, certificate = "tenant-01") => new Headers({ authorization: `Bearer ${token(claims)}`, "x-forwarded-client-cert": `By=spiffe;Subject="CN=${certificate}"` });
const valid = { sub: "tenant-01", iss: "ezcorp-factory-local", aud: "ezcorp-temporal", exp: Math.floor(Date.now() / 1000) + 60, permissions: ["admin:tenant-01"], jti: "grpc-1" };
const hash = "a".repeat(64);
const hashed = (claims: Record<string, unknown>, certificate = "tenant-01") => new Headers({ authorization: `Bearer ${token(claims)}`, "x-forwarded-client-cert": `By=spiffe;Hash=${hash};Subject="CN=${certificate}"` });
const none = { subjects: [], certificateHashes: [], tokenIds: [] };

let directory: string;
let silence: ReturnType<typeof spyOn>;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "authorizer-")); silence = spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(async () => { silence.mockRestore(); await rm(directory, { recursive: true, force: true }); });

describe("the gRPC route: certificate and token bound to one subject", () => {
  test("accepts only aligned certificate and signed-token claims", () => { expect(authorize(headers(valid))).toBeTrue(); });

  test("rejects issuer, audience, expiry, certificate, and foreign namespace permissions", () => {
    expect(authorize(headers({ ...valid, iss: "wrong" }))).toBeFalse();
    expect(authorize(headers({ ...valid, aud: "wrong" }))).toBeFalse();
    expect(authorize(headers({ ...valid, exp: 0 }))).toBeFalse();
    expect(authorize(headers(valid, "tenant-02"))).toBeFalse();
    expect(authorize(headers({ ...valid, permissions: ["admin:tenant-02"] }))).toBeFalse();
  });

  test("a revoked subject, certificate hash, or token ID is denied even with aligned claims", () => {
    expect(authorize(hashed(valid), none)).toBeTrue();
    expect(authorize(hashed(valid), { ...none, subjects: ["tenant-01"] })).toBeFalse();
    expect(authorize(hashed(valid), { ...none, certificateHashes: [hash] })).toBeFalse();
    expect(authorize(hashed(valid), { ...none, tokenIds: ["grpc-1"] })).toBeFalse();
    expect(authorize(hashed(valid), { subjects: ["tenant-02"], certificateHashes: ["b".repeat(64)], tokenIds: ["other"] })).toBeTrue();
  });

  test("an unreadable or corrupt revocation list denies everything, and no list configured denies nothing", async () => {
    const path = join(directory, "revocations.json");
    expect(readRevocations(undefined)).toEqual(none);
    expect(readRevocations(path)).toBeNull();
    await writeFile(path, "{not json");
    expect(readRevocations(path)).toBeNull();
    await writeFile(path, JSON.stringify({ schemaVersion: "other", subjects: [], certificateHashes: [] }));
    expect(readRevocations(path)).toBeNull();
    await writeFile(path, JSON.stringify({ schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: [], tokenIds: "x" }));
    expect(readRevocations(path)).toBeNull();
    await writeFile(path, JSON.stringify({ schemaVersion: "factory.temporal-revocations.v1", subjects: ["tenant-01"], certificateHashes: [] }));
    expect(readRevocations(path)).toEqual({ schemaVersion: "factory.temporal-revocations.v1", subjects: ["tenant-01"], certificateHashes: [], tokenIds: [] });
    expect(authorize(hashed(valid), readRevocations(path))).toBeFalse();
    expect(authorize(hashed(valid), null)).toBeFalse();
    expect(authorize(new Headers({ authorization: `Bearer ${token(valid)}` }), none)).toBeFalse();
  });
});

describe("the read-only HTTP route: every refusal decided before anything is injected", () => {
  const namespace = "tenant-01.w16";
  const readToken = token({ sub: namespace, permissions: [`read:${namespace}`], jti: "read-1" });
  const grants = (name: string) => (name === namespace ? readToken : undefined);
  const request = (path: string, options: { method?: string; certificate?: string | null; headers?: Record<string, string> } = {}) => new Request(`http://authorizer${HTTP_READ_PREFIX}${path}`, {
    method: options.method ?? "GET",
    headers: { ...(options.certificate === null ? {} : { "x-forwarded-client-cert": `By=spiffe;Hash=${hash};Subject="CN=${options.certificate ?? namespace}"` }), ...options.headers },
  });

  test("the two reads W15's barrier makes are allowed, and the namespace's read token is what gets injected", () => {
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), none, grants)).toEqual({ allowed: true, token: readToken });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}/workflows?query=${encodeURIComponent('WorkflowId="run-1"')}`), none, grants)).toEqual({ allowed: true, token: readToken });
  });

  test("a path naming another namespace than the certificate is refused as namespace", () => {
    expect(authorizeRead(request("/api/v1/namespaces/tenant-02.w16"), none, grants)).toEqual({ allowed: false, reason: "namespace" });
    expect(authorizeRead(request("/api/v1/namespaces/tenant-02.w16/workflows?query=x"), none, grants)).toEqual({ allowed: false, reason: "namespace" });
  });

  test("any method but GET is refused as method, with a valid certificate", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`, { method }), none, grants)).toEqual({ allowed: false, reason: "method" });
  });

  test("any other path or query is refused as path, with a valid certificate", () => {
    for (const path of [
      `/api/v1/namespaces/${namespace}/workflows/run-1`, `/api/v1/namespaces/${namespace}/schedules`, "/api/v1/namespaces", "/api/v1/system-info",
      `/api/v1/namespaces/${namespace}?view=full`, `/api/v1/namespaces/${namespace}/workflows?query=x&pageSize=9`, "/api/v1/namespaces/%E0%A4%A",
    ]) expect({ path, decision: authorizeRead(request(path), none, grants) }).toEqual({ path, decision: { allowed: false, reason: "path" } });
  });

  test("no certificate, or a revoked one, is refused as certificate", () => {
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`, { certificate: null }), none, grants)).toEqual({ allowed: false, reason: "certificate" });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), { ...none, subjects: [namespace] }, grants)).toEqual({ allowed: false, reason: "certificate" });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), { ...none, certificateHashes: [hash] }, grants)).toEqual({ allowed: false, reason: "certificate" });
  });

  test("a caller's own Authorization header is refused as token, so no token can be smuggled past the injection", () => {
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`, { headers: { authorization: `Bearer ${readToken}` } }), none, grants)).toEqual({ allowed: false, reason: "token" });
  });

  test("a missing, foreign, unscoped, or revoked read token is refused as grant", () => {
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), none, () => undefined)).toEqual({ allowed: false, reason: "grant" });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), none, () => token({ sub: "tenant-02.w16", permissions: [`read:${namespace}`] }))).toEqual({ allowed: false, reason: "grant" });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), none, () => token({ sub: namespace, permissions: [`admin:${namespace}`] }))).toEqual({ allowed: false, reason: "grant" });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), none, () => token({ sub: namespace }))).toEqual({ allowed: false, reason: "grant" });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), { ...none, tokenIds: ["read-1"] }, grants)).toEqual({ allowed: false, reason: "grant" });
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), none, () => "not-a-token")).toEqual({ allowed: false, reason: "grant" });
  });

  test("an unreadable revocation list refuses every read", () => {
    expect(authorizeRead(request(`/api/v1/namespaces/${namespace}`), null, grants)).toEqual({ allowed: false, reason: "revocations" });
  });

  test("read tokens come from one file per namespace, and a name that could traverse reads nothing", async () => {
    await writeFile(join(directory, `${namespace}.token`), `${readToken}\n`);
    expect(readTokenFrom(directory)(namespace)).toBe(readToken);
    expect(readTokenFrom(directory)("tenant-09.w16")).toBeUndefined();
    expect(readTokenFrom(directory)("../escape")).toBeUndefined();
    expect(readTokenFrom(undefined)(namespace)).toBeUndefined();
  });

  test("the handler injects the token on an allowed read and answers a typed 403 on a refused one; the gRPC route keeps its answers", async () => {
    await writeFile(join(directory, `${namespace}.token`), readToken);
    const environment = { FACTORY_TEMPORAL_HTTP_TOKENS: directory };
    const allowed = handle(request(`/api/v1/namespaces/${namespace}`), environment);
    expect([allowed.status, allowed.headers.get("authorization")]).toEqual([200, `Bearer ${readToken}`]);
    const refused = handle(request(`/api/v1/namespaces/${namespace}`, { method: "DELETE" }), environment);
    expect([refused.status, refused.headers.get("authorization"), await refused.json()]).toEqual([403, null, { error: "temporal_http_forbidden", reason: "method" }]);
    const grpc = handle(new Request("http://authorizer/temporal.api.workflowservice.v1.WorkflowService/DescribeNamespace", { headers: hashed(valid) }), {});
    expect(grpc.status).toBe(200);
    const denied = handle(new Request("http://authorizer/temporal.api.workflowservice.v1.WorkflowService/DescribeNamespace", { headers: hashed(valid, "tenant-02") }), {});
    expect([denied.status, await denied.text()]).toEqual([403, "certificate and JWT claims must match"]);
    expect(handle(request(`/api/v1/namespaces/${namespace}`)).status).toBe(403);
  });
});
