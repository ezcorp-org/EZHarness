import { createSign, generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import { verifyPoolToken } from "./service-token";
import { authenticatePoolPrincipal } from "./service";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const options = { issuer: "factory-test", audience: "factory-pool", publicKeys: { test: keys.publicKey.export({ type: "pkcs1", format: "pem" }).toString() } };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "test" }): string { const input = `${encode(header)}.${encode(payload)}`; const signer = createSign("RSA-SHA256"); signer.update(input); signer.end(); return `${input}.${signer.sign(keys.privateKey).toString("base64url")}`; }
const claims = { sub: "tenant-one", iss: "factory-test", aud: "factory-pool", exp: Math.floor(Date.now() / 1000) + 60, scope: ["pool:tenant:tenant-01"] };

test("verifies a signed issuer/audience-bound pool token", () => { expect(verifyPoolToken(token(claims), options).sub).toBe("tenant-one"); });
test("rejects malformed, altered, untrusted, expired, and invalid scope tokens", () => {
  for (const value of ["bad", `${token(claims)}x`, token(claims, { alg: "none", kid: "test" }), token(claims, { alg: "RS256", kid: "missing" }), token({ ...claims, iss: "wrong" }), token({ ...claims, aud: ["wrong"] }), token({ ...claims, exp: 1 }), token({ ...claims, scope: "wrong" })]) expect(() => verifyPoolToken(value, options)).toThrow();
});


test("binds configured certificate identities to matching token subjects and roles", () => {
  const identities = { tenants: { "tenant-one": { tenantId: "tenant-01", tokenSubject: "tenant-one" } }, supervisors: { "supervisor-one": { supervisorId: "supervisor-a", tokenSubject: "supervisor-one", hostIds: ["gpu-a"] } } };
  expect(authenticatePoolPrincipal("tenant-one", token(claims), identities, options).kind).toBe("tenant");
  expect(authenticatePoolPrincipal("supervisor-one", token({ ...claims, sub: "supervisor-one", scope: ["pool:supervisor:supervisor-a"] }), identities, options).kind).toBe("supervisor");
  for (const input of [["tenant-one", token({ ...claims, sub: "other" })], ["tenant-one", token({ ...claims, scope: [] })], ["unknown", token(claims)]]) expect(() => authenticatePoolPrincipal(input[0], input[1], identities, options)).toThrow();
});
