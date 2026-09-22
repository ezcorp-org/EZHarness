import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, createVerify, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, makeFactoryTestInstallation, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import { createFactoryCertificateAuthority, issueFactoryCertificate } from "./certificates";
import type { FactoryInstallationContext } from "./installation";
import { FactoryProvisioningError } from "./steps";
import {
  FACTORY_TEMPORAL_AUDIENCE,
  FACTORY_TEMPORAL_ISSUER,
  FactoryTemporalStep,
  factoryCertificateHash,
  factoryTemporalCertificateIssuer,
  factoryTemporalJwks,
  factoryTemporalOwnerMarker,
  factoryTemporalToken,
  parseFactoryTemporalRevocations,
  revokeFactoryTemporalIdentity,
  type FactoryTemporalAccessProbe,
  type FactoryTemporalAuthorityPaths,
  type FactoryTemporalClientCredential,
  type FactoryTemporalNamespaceAdmin,
} from "./temporal";

const NOW_MS = 1_800_000_000_000;
const KEY_ID = "factory-local";

/** One CA and one token key for the whole file: openssl and RSA generation are slow. */
let authorityRoot: string;
let caPem: string;
let caKeyPem: string;
let tokenKeyPem: string;

beforeAll(async () => {
  authorityRoot = await makeFactoryPrivateRoot();
  const ca = await createFactoryCertificateAuthority("factory-temporal-ca");
  caPem = ca.certificatePem;
  caKeyPem = ca.privateKeyPem;
  tokenKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterAll(async () => { await removeFactoryPrivateRoot(authorityRoot); });

let root: string;
let authority: FactoryTemporalAuthorityPaths;
let installation: FactoryInstallationContext;

beforeEach(async () => {
  root = await makeFactoryPrivateRoot();
  const directory = join(root, "authority");
  await mkdir(directory, { mode: 0o700 });
  authority = {
    caCertificatePath: await writeModeFile(join(directory, "ca.crt"), caPem),
    caKeyPath: await writeModeFile(join(directory, "ca.key"), caKeyPem),
    tokenKeyPath: await writeModeFile(join(directory, "token.key"), tokenKeyPem),
    tokenKeyId: KEY_ID,
    revocationsPath: join(directory, "revocations", "revocations.json"),
  };
  installation = makeFactoryTestInstallation(root);
});
afterEach(async () => { await removeFactoryPrivateRoot(root); });

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Verify an RS256 token with only the published JWKS, as the gateway does. Returns its claims. */
function verifiedClaims(token: string, jwks = factoryTemporalJwks(tokenKeyPem, KEY_ID)): Record<string, unknown> | undefined {
  const [header, payload, signature] = token.trim().split(".");
  const kid = decodeSegment(header!).kid;
  const jwk = jwks.keys.find((key) => key.kid === kid);
  if (!jwk) return undefined;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(signature!, "base64url")) ? decodeSegment(payload!) : undefined;
}

async function revocations(): Promise<{ subjects: string[]; certificateHashes: string[] }> {
  return JSON.parse(await readFile(authority.revocationsPath, "utf8"));
}

/** A namespace registry that remembers owner markers. */
class FakeAdmin implements FactoryTemporalNamespaceAdmin {
  readonly owners = new Map<string, string>();
  readonly registered: Array<[string, string]> = [];
  async register(namespace: string, ownerMarker: string): Promise<void> { this.registered.push([namespace, ownerMarker]); this.owners.set(namespace, ownerMarker); }
  async owner(namespace: string): Promise<string | undefined> { return this.owners.get(namespace); }
}

/**
 * The gateway's authorizer, in miniature: the certificate chains to the CA,
 * its CN equals the token subject, the token verifies and carries
 * `admin:<namespace>`, and neither the subject nor the certificate hash is revoked.
 */
class GatewayAccess implements FactoryTemporalAccessProbe {
  readonly seen: FactoryTemporalClientCredential[] = [];
  async describe(namespace: string, credential: FactoryTemporalClientCredential): Promise<boolean> {
    this.seen.push(credential);
    const certificatePem = await readFile(credential.certificatePath, "utf8");
    const certificate = new X509Certificate(certificatePem);
    const ca = new X509Certificate(await readFile(credential.caCertificatePath, "utf8"));
    const claims = verifiedClaims(await readFile(credential.tokenPath, "utf8"));
    const revoked = await revocations().catch(() => ({ subjects: [] as string[], certificateHashes: [] as string[] }));
    return certificate.verify(ca.publicKey)
      && certificate.subject === `CN=${claims?.sub}`
      && (claims?.permissions as string[] | undefined)?.includes(`admin:${namespace}`) === true
      && !revoked.subjects.includes(String(claims?.sub))
      && !revoked.certificateHashes.includes(factoryCertificateHash(certificatePem));
  }
}

function makeStep(overrides: Partial<ConstructorParameters<typeof FactoryTemporalStep>[0]> = {}) {
  const admin = new FakeAdmin();
  const access = new GatewayAccess();
  const step = new FactoryTemporalStep({ authority, admin, access, certificates: factoryTemporalCertificateIssuer(), now: () => NOW_MS, ...overrides });
  return { step, admin, access };
}

async function loadedStep(overrides: Partial<ConstructorParameters<typeof FactoryTemporalStep>[0]> = {}) {
  const made = makeStep(overrides);
  await made.step.load();
  return made;
}

describe("identity helpers", () => {
  test("the owner marker names the fleet and the installation", () => {
    expect(factoryTemporalOwnerMarker(installation)).toBe("factory-provisioner:fleet-a:inst-tenant-01");
  });

  test("the certificate hash is SHA-256 over the DER bytes, lowercase hex", () => {
    expect(factoryCertificateHash(caPem)).toBe(createHash("sha256").update(new X509Certificate(caPem).raw).digest("hex"));
    expect(factoryCertificateHash(caPem)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("factoryTemporalToken and factoryTemporalJwks", () => {
  test("the token is RS256 under the JWKS key and carries exactly the requested subject and permissions", () => {
    const token = factoryTemporalToken("tenant-01.fleet-a", ["admin:tenant-01.fleet-a"], tokenKeyPem, KEY_ID, 1_000);
    const [header] = token.split(".");
    expect(decodeSegment(header!)).toEqual({ alg: "RS256", kid: KEY_ID, typ: "JWT" });
    const claims = verifiedClaims(token)!;
    expect(claims).toMatchObject({ sub: "tenant-01.fleet-a", iss: FACTORY_TEMPORAL_ISSUER, aud: FACTORY_TEMPORAL_AUDIENCE, permissions: ["admin:tenant-01.fleet-a"], iat: 1_000, exp: 1_000 + 30 * 24 * 60 * 60 });
    expect(claims.jti).toMatch(/^[a-f0-9]{32}$/);
  });

  test("a custom lifetime bounds exp, and two tokens never share a jti", () => {
    const a = verifiedClaims(factoryTemporalToken("s", [], tokenKeyPem, KEY_ID, 50, 300))!;
    const b = verifiedClaims(factoryTemporalToken("s", [], tokenKeyPem, KEY_ID, 50, 300))!;
    expect(a.exp).toBe(350);
    expect(a.permissions).toEqual([]);
    expect(a.jti).not.toBe(b.jti);
  });

  test("a tampered payload or a foreign key id does not verify", () => {
    const [header, , signature] = factoryTemporalToken("tenant-01.fleet-a", ["admin:tenant-01.fleet-a"], tokenKeyPem, KEY_ID, 1_000).split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "tenant-02.fleet-a", permissions: ["admin:tenant-02.fleet-a"] })).toString("base64url");
    expect(verifiedClaims(`${header}.${forged}.${signature}`)).toBeUndefined();
    expect(verifiedClaims(factoryTemporalToken("s", [], tokenKeyPem, "other-kid", 1))).toBeUndefined();
  });

  test("the JWKS publishes only the public RSA half", () => {
    const jwks = factoryTemporalJwks(tokenKeyPem, KEY_ID);
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]!).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: KEY_ID, e: "AQAB" });
  });
});

describe("parseFactoryTemporalRevocations", () => {
  const hash = "a".repeat(64);
  test("accepts a well-formed list and returns copies", () => {
    const input = { schemaVersion: "factory.temporal-revocations.v1", subjects: ["x"], certificateHashes: [hash] };
    const parsed = parseFactoryTemporalRevocations(input);
    expect(parsed).toEqual(input as never);
    expect(parsed.subjects).not.toBe(input.subjects);
  });

  const corrupt: Array<[string, unknown]> = [
    ["null", null],
    ["a wrong schema", { schemaVersion: "v0", subjects: [], certificateHashes: [] }],
    ["subjects not a list", { schemaVersion: "factory.temporal-revocations.v1", subjects: "x", certificateHashes: [] }],
    ["hashes not a list", { schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: {} }],
    ["a numeric subject", { schemaVersion: "factory.temporal-revocations.v1", subjects: [1], certificateHashes: [] }],
    ["a short hash", { schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: ["abc"] }],
    ["an uppercase hash", { schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: ["A".repeat(64)] }],
    ["a numeric hash", { schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: [5] }],
  ];
  for (const [name, value] of corrupt) {
    test(`refuses ${name}`, () => {
      let caught: unknown;
      try { parseFactoryTemporalRevocations(value); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(FactoryProvisioningError);
      expect((caught as FactoryProvisioningError).code).toBe("temporal_revocations_corrupt");
    });
  }
});

describe("revokeFactoryTemporalIdentity", () => {
  const hashA = "a".repeat(64), hashB = "b".repeat(64);

  test("creates a missing list privately, then appends sorted and deduplicated entries", async () => {
    await revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: "tenant-02.fleet-a", certificateHash: hashB });
    expect((await stat(authority.revocationsPath)).mode & 0o777).toBe(0o600);
    await revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: "tenant-01.fleet-a" });
    await revokeFactoryTemporalIdentity(authority.revocationsPath, { certificateHash: hashA });
    expect(await revocations()).toEqual({ schemaVersion: "factory.temporal-revocations.v1", subjects: ["tenant-01.fleet-a", "tenant-02.fleet-a"], certificateHashes: [hashA, hashB] } as never);
  });

  test("revoking the same entry twice, or nothing at all, leaves the list unchanged", async () => {
    await revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: "s", certificateHash: hashA });
    const once = await readFile(authority.revocationsPath, "utf8");
    await revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: "s", certificateHash: hashA });
    await revokeFactoryTemporalIdentity(authority.revocationsPath, {});
    expect(await readFile(authority.revocationsPath, "utf8")).toBe(once);
  });

  test("a corrupt list is refused and never overwritten", async () => {
    await mkdir(join(authority.revocationsPath, ".."), { mode: 0o700 });
    const corrupt = JSON.stringify({ schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: ["not-a-hash"] });
    await writeModeFile(authority.revocationsPath, corrupt);
    expect((await factoryRejection(revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: "s" }))).code).toBe("temporal_revocations_corrupt");
    expect(await readFile(authority.revocationsPath, "utf8")).toBe(corrupt);
  });

  test("a list that is not JSON is refused and never overwritten", async () => {
    await mkdir(join(authority.revocationsPath, ".."), { mode: 0o700 });
    await writeModeFile(authority.revocationsPath, "{truncated");
    expect(await factoryRejection(revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: "s" }))).toMatchObject({ code: "temporal_revocations_corrupt" });
    expect(await readFile(authority.revocationsPath, "utf8")).toBe("{truncated");
  });

  test("concurrent revocations of one entry leave exactly one copy of it", async () => {
    await Promise.all([1, 2, 3].map(() => revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: "same" })));
    expect((await revocations()).subjects).toEqual(["same"]);
  });
});

describe("FactoryTemporalStep", () => {
  test("load refuses a missing token key by filesystem name", async () => {
    const { step } = makeStep({ authority: { ...authority, tokenKeyPath: join(root, "authority", "absent.key") } });
    expect((await factoryRejection(step.load())).code).toBe("ENOENT");
  });

  test("ensure issues a namespace-subject certificate, a verified token, and registers the namespace with provenance", async () => {
    const { step, admin, access } = await loadedStep();
    const resources = await step.ensure(installation);
    const credential = step.credential(installation);
    expect(resources).toEqual({
      namespace: "tenant-01.fleet-a",
      ownerMarker: "factory-provisioner:fleet-a:inst-tenant-01",
      certificatePath: join(installation.secretDirectory, "temporal-client.crt"),
      privateKeyPath: join(installation.secretDirectory, "temporal-client.key"),
      caCertificatePath: join(installation.secretDirectory, "temporal-ca.crt"),
      tokenPath: join(installation.secretDirectory, "temporal-token"),
      certificateHash: factoryCertificateHash(await readFile(credential.certificatePath, "utf8")),
    });
    expect(admin.registered).toEqual([["tenant-01.fleet-a", "factory-provisioner:fleet-a:inst-tenant-01"]]);
    const certificate = new X509Certificate(await readFile(credential.certificatePath, "utf8"));
    expect(certificate.subject).toBe("CN=tenant-01.fleet-a");
    expect(certificate.verify(new X509Certificate(caPem).publicKey)).toBe(true);
    expect(certificate.checkPrivateKey(createPrivateKey(await readFile(credential.privateKeyPath, "utf8")))).toBe(true);
    expect(await readFile(credential.caCertificatePath, "utf8")).toBe(caPem);
    const claims = verifiedClaims(await readFile(credential.tokenPath, "utf8"))!;
    expect(claims).toMatchObject({ sub: "tenant-01.fleet-a", permissions: ["admin:tenant-01.fleet-a"], iat: NOW_MS / 1_000 });
    for (const path of Object.values(credential)) expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(access.seen).toEqual([credential]);
  });

  test("a rerun registers nothing, reissues nothing, and returns the same resources", async () => {
    const { step, admin } = await loadedStep();
    const first = await step.ensure(installation);
    const token = await readFile(step.credential(installation).tokenPath, "utf8");
    const second = await step.ensure(installation);
    expect(second).toEqual(first);
    expect(admin.registered).toHaveLength(1);
    expect(await readFile(step.credential(installation).tokenPath, "utf8")).toBe(token);
  });

  test("ensure before load fails by name after the certificate is written, and a loaded rerun keeps that certificate", async () => {
    const { step, admin } = makeStep();
    const error = await factoryRejection(step.ensure(installation));
    expect(error.code).toBe("temporal_authority_unloaded");
    expect(admin.registered).toEqual([]);
    const certificatePem = await readFile(step.credential(installation).certificatePath, "utf8");
    expect(await Bun.file(step.credential(installation).tokenPath).exists()).toBe(false);
    await step.load();
    const resources = await step.ensure(installation);
    expect(resources.certificateHash).toBe(factoryCertificateHash(certificatePem));
    expect(admin.registered).toHaveLength(1);
  });

  test("a key a crash left without its certificate is replaced, never paired with a new certificate", async () => {
    const { step } = await loadedStep();
    await mkdir(installation.secretDirectory, { recursive: true, mode: 0o700 });
    const stale = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeModeFile(step.credential(installation).privateKeyPath, stale);
    await step.ensure(installation);
    const key = await readFile(step.credential(installation).privateKeyPath, "utf8");
    expect(key).not.toBe(stale);
    expect(new X509Certificate(await readFile(step.credential(installation).certificatePath, "utf8")).checkPrivateKey(createPrivateKey(key))).toBe(true);
  });

  test("a namespace registered by someone else is never adopted and nothing is written", async () => {
    const { step, admin } = await loadedStep();
    admin.owners.set("tenant-01.fleet-a", "factory-provisioner:fleet-a:someone-else");
    const error = await factoryRejection(step.ensure(installation));
    expect(error.code).toBe("temporal_namespace_foreign");
    expect(admin.registered).toEqual([]);
    expect(await Bun.file(step.credential(installation).certificatePath).exists()).toBe(false);
  });

  test("an issuer failure stops ensure before any key is written", async () => {
    const { step } = await loadedStep({ certificates: factoryTemporalCertificateIssuer(async () => { throw new FactoryProvisioningError("certificate_issue_failed", "openssl exited 1"); }) });
    expect((await factoryRejection(step.ensure(installation))).code).toBe("certificate_issue_failed");
    expect(await Bun.file(step.credential(installation).privateKeyPath).exists()).toBe(false);
  });

  test("an authority CA readable by others is refused by the private reader", async () => {
    await chmod(authority.caCertificatePath, 0o644);
    const { step } = await loadedStep();
    expect((await factoryRejection(step.ensure(installation))).message).toBe("Private file must be owned, private, regular, and bounded.");
  });

  test("two tenants provisioned concurrently get separate identities that cannot address each other", async () => {
    const { step, access } = await loadedStep();
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    const [mine, theirs] = await Promise.all([step.ensure(installation), step.ensure(other)]);
    expect(mine.certificateHash).not.toBe(theirs.certificateHash);
    expect(await access.describe(other.temporalNamespace, step.credential(installation))).toBe(false);
    expect(await access.describe(installation.temporalNamespace, step.credential(other))).toBe(false);
  });

  describe("verify", () => {
    test("refuses a namespace that has gone missing", async () => {
      const { step, admin } = await loadedStep();
      const resources = await step.ensure(installation);
      admin.owners.delete("tenant-01.fleet-a");
      expect((await factoryRejection(step.verify(installation, resources))).code).toBe("temporal_namespace_missing");
    });

    test("refuses a certificate issued for another subject", async () => {
      const { step } = await loadedStep();
      const resources = await step.ensure(installation);
      const foreign = await issueFactoryCertificate({ certificatePath: authority.caCertificatePath, keyPath: authority.caKeyPath }, { subject: "tenant-02.fleet-a", usage: "client" });
      await writeModeFile(step.credential(installation).certificatePath, foreign.certificatePem);
      expect((await factoryRejection(step.verify(installation, resources))).code).toBe("temporal_certificate_subject");
    });

    test("refuses a recorded hash that is not the certificate on disk", async () => {
      const { step } = await loadedStep();
      const resources = await step.ensure(installation);
      expect((await factoryRejection(step.verify(installation, { ...resources, certificateHash: "0".repeat(64) }))).code).toBe("temporal_resource_mismatch");
    });

    test("refuses a credential the gateway denies", async () => {
      const { step } = await loadedStep();
      const resources = await step.ensure(installation);
      await revokeFactoryTemporalIdentity(authority.revocationsPath, { subject: installation.temporalNamespace });
      expect((await factoryRejection(step.verify(installation, resources))).code).toBe("temporal_access_denied");
    });
  });

  describe("teardown", () => {
    test("revokes the subject and certificate hash, removes every private copy, and succeeds twice", async () => {
      const { step, access } = await loadedStep();
      const resources = await step.ensure(installation);
      await step.teardown(installation, resources);
      expect(await revocations()).toEqual({ schemaVersion: "factory.temporal-revocations.v1", subjects: ["tenant-01.fleet-a"], certificateHashes: [resources.certificateHash!] } as never);
      for (const path of Object.values(step.credential(installation))) expect(await Bun.file(path).exists()).toBe(false);
      await step.teardown(installation, resources);
      expect((await revocations()).subjects).toEqual(["tenant-01.fleet-a"]);
      expect(access.seen).toHaveLength(1);
    });

    test("without a recorded hash, revokes the subject only", async () => {
      const { step } = await loadedStep();
      await step.teardown(installation, {});
      expect(await revocations()).toEqual({ schemaVersion: "factory.temporal-revocations.v1", subjects: ["tenant-01.fleet-a"], certificateHashes: [] } as never);
    });
  });

  describe("rotate", () => {
    test("replaces key, certificate, and token, and revokes only the superseded certificate", async () => {
      const { step, access } = await loadedStep();
      const before = await step.ensure(installation);
      const oldPem = await readFile(step.credential(installation).certificatePath, "utf8");
      const oldToken = await readFile(step.credential(installation).tokenPath, "utf8");
      const after = await step.rotate(installation, before);
      expect(after.certificateHash).not.toBe(before.certificateHash);
      expect(after).toEqual({ ...before, certificateHash: after.certificateHash! });
      expect(await revocations()).toEqual({ schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: [before.certificateHash!] } as never);
      expect(await readFile(step.credential(installation).tokenPath, "utf8")).not.toBe(oldToken);
      expect(new X509Certificate(await readFile(step.credential(installation).certificatePath, "utf8")).subject).toBe("CN=tenant-01.fleet-a");
      await writeModeFile(join(root, "old.crt"), oldPem);
      expect(await access.describe(installation.temporalNamespace, { ...step.credential(installation), certificatePath: join(root, "old.crt") })).toBe(false);
      for (const path of Object.values(step.credential(installation))) expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    test("without a recorded hash, rotates without revoking anything", async () => {
      const { step } = await loadedStep();
      await step.ensure(installation);
      const { certificateHash: _dropped, ...unhashed } = await step.ensure(installation);
      const after = await step.rotate(installation, unhashed);
      expect(after.certificateHash).toMatch(/^[a-f0-9]{64}$/);
      expect(await Bun.file(authority.revocationsPath).exists()).toBe(false);
    });

    test("rotate before load fails by name", async () => {
      const { step } = makeStep();
      expect((await factoryRejection(step.rotate(installation, {}))).code).toBe("temporal_authority_unloaded");
    });
  });

  test("rm of the secret directory between ensure and verify surfaces ENOENT", async () => {
    const { step } = await loadedStep();
    const resources = await step.ensure(installation);
    await rm(installation.secretDirectory, { recursive: true });
    expect((await factoryRejection(step.verify(installation, resources))).code).toBe("ENOENT");
  });
});
