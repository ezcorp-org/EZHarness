import { expect, test } from "bun:test";
import { authorize, readRevocations } from "./factory-temporal-authorizer.mjs";

const token = (claims: Record<string, unknown>) => `Bearer x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;
const headers = (claims: Record<string, unknown>, certificate = "tenant-01") => new Headers({ authorization: token(claims), "x-forwarded-client-cert": `By=spiffe;Subject="CN=${certificate}"` });
const valid = { sub: "tenant-01", iss: "ezcorp-factory-local", aud: "ezcorp-temporal", exp: Math.floor(Date.now() / 1000) + 60, permissions: ["admin:tenant-01"] };

test("accepts only aligned certificate and signed-token claims", () => { expect(authorize(headers(valid))).toBeTrue(); });
test("rejects issuer, audience, expiry, certificate, and foreign namespace permissions", () => {
  expect(authorize(headers({ ...valid, iss: "wrong" }))).toBeFalse();
  expect(authorize(headers({ ...valid, aud: "wrong" }))).toBeFalse();
  expect(authorize(headers({ ...valid, exp: 0 }))).toBeFalse();
  expect(authorize(headers(valid, "tenant-02"))).toBeFalse();
  expect(authorize(headers({ ...valid, permissions: ["admin:tenant-02"] }))).toBeFalse();
});

const hash = "a".repeat(64);
const hashed = (claims: Record<string, unknown>, certificate = "tenant-01") => new Headers({ authorization: token(claims), "x-forwarded-client-cert": `By=spiffe;Hash=${hash};Subject="CN=${certificate}"` });
const none = { subjects: [], certificateHashes: [] };

test("a revoked subject or certificate hash is denied even with aligned claims", () => {
  expect(authorize(hashed(valid), none)).toBeTrue();
  expect(authorize(hashed(valid), { subjects: ["tenant-01"], certificateHashes: [] })).toBeFalse();
  expect(authorize(hashed(valid), { subjects: [], certificateHashes: [hash] })).toBeFalse();
  expect(authorize(hashed(valid), { subjects: ["tenant-02"], certificateHashes: ["b".repeat(64)] })).toBeTrue();
});

test("an unreadable or corrupt revocation list denies everything, and no list configured denies nothing", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "authorizer-"));
  try {
    const path = join(directory, "revocations.json");
    expect(readRevocations(undefined)).toEqual(none);
    expect(readRevocations(path)).toBeNull();
    await writeFile(path, "{not json");
    expect(readRevocations(path)).toBeNull();
    await writeFile(path, JSON.stringify({ schemaVersion: "other", subjects: [], certificateHashes: [] }));
    expect(readRevocations(path)).toBeNull();
    await writeFile(path, JSON.stringify({ schemaVersion: "factory.temporal-revocations.v1", subjects: ["tenant-01"], certificateHashes: [] }));
    expect(authorize(hashed(valid), readRevocations(path))).toBeFalse();
    expect(authorize(hashed(valid), null)).toBeFalse();
    expect(authorize(new Headers({ authorization: token(valid) }), none)).toBeFalse();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
