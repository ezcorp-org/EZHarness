import { describe, expect, test } from "bun:test";
import { signFactoryServiceToken, verifyFactoryServiceToken } from "../auth/factory-service-token";
import { signInstallationToken, verifyJWT } from "../auth/jwt";

const secret = "factory-service-test-secret-with-sufficient-entropy";
const installation = "factory-installation-a";
const issuedAtMs = Math.floor(Date.now() / 1_000) * 1_000;
const identity = {
  serviceAccountId: "service-a", projectId: "project-a", credentialId: "credential-a",
  revision: 1, scopes: ["read", "chat"] as const, issuedAtMs, expiresAtMs: issuedAtMs + 60_000,
};

describe("factory service tokens", () => {
  test("round trips deterministically and stays disjoint from user sessions", async () => {
    const first = await signFactoryServiceToken(identity, secret, installation);
    const second = await signFactoryServiceToken(identity, secret, installation);
    expect(second).toBe(first);
    expect(await verifyFactoryServiceToken(first, secret, installation)).toEqual({ tokenUse: "factory-service", ...identity, scopes: ["read", "chat"] });
    expect(await verifyFactoryServiceToken(first, secret, "foreign-installation")).toBeNull();
    expect(await verifyJWT(first.slice("ezkfsvc_".length), secret, installation)).toBeNull();
  });

  test("rejects malformed identities, claims, scope order, expiry, and prefixes", async () => {
    await expect(signFactoryServiceToken({ ...identity, scopes: ["read", "read"] }, secret, installation)).rejects.toThrow();
    await expect(signFactoryServiceToken({ ...identity, issuedAtMs: issuedAtMs + 1 }, secret, installation)).rejects.toThrow();
    expect(await verifyFactoryServiceToken("not-a-service-token", secret, installation)).toBeNull();
    const invalid = await signInstallationToken({
      tokenUse: "factory-service", sub: identity.serviceAccountId, projectId: identity.projectId,
      credentialId: identity.credentialId, revision: 1, scopes: ["chat", "read"],
      issuedAtMs, expiresAtMs: issuedAtMs + 60_000, iat: issuedAtMs / 1_000, exp: issuedAtMs / 1_000 + 60,
    }, secret, installation);
    expect(await verifyFactoryServiceToken(`ezkfsvc_${invalid}`, secret, installation)).toBeNull();
  });
});
