import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, createVerify, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, makeFactoryTestInstallation, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import { createFactoryCertificateAuthority, factorySpawnRunner, issueFactoryCertificate, type FactoryCommandRunner } from "./certificates";
import type { FactoryInstallationContext } from "./installation";
import { FactoryProvisioningError } from "./steps";
import {
  FACTORY_MESH_FILES,
  FACTORY_MESH_OPERATOR_FILES,
  FACTORY_MESH_TOKEN_KEY_ID,
  FACTORY_PRIVATE_SERVICE_AUDIENCE,
  ensureFactoryMesh,
  factoryMeshIdentities,
  factoryMeshToken,
  factoryMeshTokenExpiry,
  rotateFactoryMesh,
} from "./mesh";

/** Every file the installation mesh writes to the secret directory. The pool token is the fleet host's. */
const MESH_WRITTEN = Object.values(FACTORY_MESH_FILES).filter((name) => name !== FACTORY_MESH_FILES.harnessPoolToken);

const NOW_MS = 1_800_000_000_000;
let root: string;
let installation: FactoryInstallationContext;

beforeEach(async () => {
  root = await makeFactoryPrivateRoot();
  installation = makeFactoryTestInstallation(root);
});
afterEach(async () => { await removeFactoryPrivateRoot(root); });

const secret = (name: string, target = installation) => join(target.secretDirectory, name);
const operator = (name: string, target = installation) => join(target.operatorDirectory, name);
const text = (path: string) => readFile(path, "utf8");

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) entries[name] = await text(join(directory, name));
  return entries;
}

function claimsUnder(publicKeyPem: string, token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } | undefined {
  const [header, payload, signature] = token.trim().split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  if (!verifier.verify(createPublicKey(publicKeyPem), Buffer.from(signature!, "base64url"))) return undefined;
  const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  return { header: decode(header!), claims: decode(payload!) };
}

function certificate(pem: string): X509Certificate { return new X509Certificate(pem); }

describe("factoryMeshIdentities and factoryMeshToken", () => {
  test("identities are scoped by tenant, fleet, and installation", () => {
    expect(factoryMeshIdentities(installation)).toEqual({
      harness: "harness.tenant-01", orchestrator: "orchestrator.tenant-01", issuer: "factory-mesh:inst-tenant-01",
    });
  });

  test("a token is RS256 under the mesh key with exactly its subject, audience, and scope", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const token = factoryMeshToken({ subject: "s", issuer: "i", audience: "a", scope: ["x", "y"], keyPem, nowSeconds: 10 });
    const decoded = claimsUnder(pair.publicKey.export({ type: "spki", format: "pem" }).toString(), token)!;
    expect(decoded.header).toEqual({ alg: "RS256", kid: FACTORY_MESH_TOKEN_KEY_ID, typ: "JWT" });
    expect(decoded.claims).toMatchObject({ sub: "s", iss: "i", aud: "a", scope: ["x", "y"], iat: 10, exp: 10 + 30 * 24 * 60 * 60 });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(claimsUnder(other, token)).toBeUndefined();
    expect(factoryMeshTokenExpiry(`${token}\n`)).toBe((10 + 30 * 24 * 60 * 60) * 1_000);
  });

  test("an expiry is read only from a token that has one", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const token of ["not-a-token", `${encode({})}.${Buffer.from("{broken").toString("base64url")}.x`, `${encode({})}.${encode(null)}.x`, `${encode({})}.${encode({ exp: "soon" })}.x`]) expect(factoryMeshTokenExpiry(token)).toBeUndefined();
    // Anything but a malformed token is a bug in the caller, and surfaces.
    expect(() => factoryMeshTokenExpiry(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe("ensureFactoryMesh", () => {
  test("creates a per-installation authority and every certificate chains to it with the expected subject", async () => {
    await ensureFactoryMesh(installation, { now: () => NOW_MS });
    const caPem = await text(operator(FACTORY_MESH_OPERATOR_FILES.caCertificate));
    expect(await text(secret(FACTORY_MESH_FILES.caCertificate))).toBe(caPem);
    const ca = certificate(caPem);
    expect(ca.subject).toBe("CN=mesh.tenant-01");
    expect(ca.ca).toBe(true);
    const expected: Array<[string, string, string]> = [
      [FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, "CN=localhost"],
      [FACTORY_MESH_FILES.harnessCertificate, FACTORY_MESH_FILES.harnessKey, "CN=harness.tenant-01"],
      [FACTORY_MESH_FILES.orchestratorCertificate, FACTORY_MESH_FILES.orchestratorKey, "CN=orchestrator.tenant-01"],
    ];
    for (const [certificateFile, keyFile, subject] of expected) {
      const leaf = certificate(await text(secret(certificateFile)));
      expect(leaf.subject).toBe(subject);
      expect(leaf.issuer).toBe("CN=mesh.tenant-01");
      expect(leaf.verify(ca.publicKey)).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.checkPrivateKey(createPrivateKey(await text(secret(keyFile))))).toBe(true);
    }
    const server = certificate(await text(secret(FACTORY_MESH_FILES.serverCertificate)));
    expect(server.checkHost("localhost")).toBe("localhost");
    expect(server.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(server.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(certificate(await text(secret(FACTORY_MESH_FILES.harnessCertificate))).keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
  });

  test("the orchestrator's token verifies with the delivered public key and carries its audience and scope; no pool token is minted here", async () => {
    const state = await ensureFactoryMesh(installation, { now: () => NOW_MS });
    const publicKeyPem = await text(secret(FACTORY_MESH_FILES.tokenPublicKey));
    expect(createPublicKey(createPrivateKey(await text(operator(FACTORY_MESH_OPERATOR_FILES.tokenKey)))).export({ type: "spki", format: "pem" }).toString()).toBe(publicKeyPem);
    const decoded = claimsUnder(publicKeyPem, await text(secret(FACTORY_MESH_FILES.orchestratorToken)));
    expect(decoded?.claims).toMatchObject({ sub: "orchestrator.tenant-01", aud: FACTORY_PRIVATE_SERVICE_AUDIENCE, scope: ["factory:orchestrate"], iss: "factory-mesh:inst-tenant-01", iat: NOW_MS / 1_000 });
    expect(state.tokensExpireAtMs).toBe(NOW_MS + 30 * 24 * 60 * 60 * 1_000);
    expect(await Bun.file(secret(FACTORY_MESH_FILES.harnessPoolToken)).exists()).toBe(false);
  });

  test("delivers an attempt-token secret and no host key; the operator keeps the authority keys", async () => {
    await ensureFactoryMesh(installation);
    expect(await text(secret(FACTORY_MESH_FILES.attemptTokenSecret))).toMatch(/^[a-f0-9]{64}\n$/);
    const delivered = await readdir(installation.secretDirectory);
    expect(delivered.sort()).toEqual([...MESH_WRITTEN].sort());
    expect(delivered.some((name) => name.startsWith("host-"))).toBe(false);
    expect(delivered).not.toContain(FACTORY_MESH_OPERATOR_FILES.caKey);
    expect(delivered).not.toContain(FACTORY_MESH_OPERATOR_FILES.tokenKey);
    expect((await readdir(installation.operatorDirectory)).sort()).toEqual(Object.values(FACTORY_MESH_OPERATOR_FILES).sort());
    for (const directory of [installation.secretDirectory, installation.operatorDirectory]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const name of await readdir(directory)) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
  });

  test("a rerun is byte-identical: nothing is reissued or rewritten", async () => {
    await ensureFactoryMesh(installation, { now: () => NOW_MS });
    const before = { secrets: await snapshot(installation.secretDirectory), operator: await snapshot(installation.operatorDirectory) };
    const calls: string[] = [];
    await ensureFactoryMesh(installation, { now: () => NOW_MS + 60_000, run: async (command, args) => { calls.push(`${command} ${args[0]}`); } });
    expect(calls).toEqual([]);
    expect({ secrets: await snapshot(installation.secretDirectory), operator: await snapshot(installation.operatorDirectory) }).toEqual(before);
  });

  test("after a crash that lost one leaf, a rerun issues only that leaf under the same authority", async () => {
    await ensureFactoryMesh(installation);
    const harness = await text(secret(FACTORY_MESH_FILES.harnessCertificate));
    await rm(secret(FACTORY_MESH_FILES.orchestratorCertificate));
    const issued: string[] = [];
    await ensureFactoryMesh(installation, { run: async (command, args) => { issued.push(args[0]!); await factorySpawnRunner(command, args); } });
    expect(issued).toEqual(["genpkey", "req", "x509"]);
    expect(await text(secret(FACTORY_MESH_FILES.harnessCertificate))).toBe(harness);
    const orchestrator = certificate(await text(secret(FACTORY_MESH_FILES.orchestratorCertificate)));
    expect(orchestrator.checkPrivateKey(createPrivateKey(await text(secret(FACTORY_MESH_FILES.orchestratorKey))))).toBe(true);
  });

  test("a CA key a crash left without its certificate is replaced, and the mesh completes", async () => {
    await mkdir(installation.operatorDirectory, { recursive: true, mode: 0o700 });
    const stale = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeModeFile(operator(FACTORY_MESH_OPERATOR_FILES.caKey), stale);
    await ensureFactoryMesh(installation);
    const ca = certificate(await text(operator(FACTORY_MESH_OPERATOR_FILES.caCertificate)));
    expect(await text(operator(FACTORY_MESH_OPERATOR_FILES.caKey))).not.toBe(stale);
    expect(ca.checkPrivateKey(createPrivateKey(await text(operator(FACTORY_MESH_OPERATOR_FILES.caKey))))).toBe(true);
  });

  test("a certificate from another authority is refused as mesh_certificate_invalid", async () => {
    await ensureFactoryMesh(installation);
    const foreignRoot = join(root, "foreign");
    await mkdir(foreignRoot, { mode: 0o700 });
    const foreign = await createFactoryCertificateAuthority("mesh.tenant-01");
    const paths = { certificatePath: await writeModeFile(join(foreignRoot, "ca.crt"), foreign.certificatePem), keyPath: await writeModeFile(join(foreignRoot, "ca.key"), foreign.privateKeyPem) };
    const forged = await issueFactoryCertificate(paths, { subject: "harness.tenant-01", usage: "client" });
    await writeModeFile(secret(FACTORY_MESH_FILES.harnessCertificate), forged.certificatePem);
    const error = await factoryRejection(ensureFactoryMesh(installation));
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    expect(error.code).toBe("mesh_certificate_invalid");
    expect(error.message).toBe("Mesh certificate mesh-harness.crt is not CN=harness.tenant-01 under this installation's authority with its own key.");
  });

  test("a certificate paired with another leaf's key is refused", async () => {
    await ensureFactoryMesh(installation);
    await writeModeFile(secret(FACTORY_MESH_FILES.harnessKey), await text(secret(FACTORY_MESH_FILES.orchestratorKey)));
    expect((await factoryRejection(ensureFactoryMesh(installation))).code).toBe("mesh_certificate_invalid");
  });

  test("an expired service token is refused as mesh_token_expired and names the remedy", async () => {
    await ensureFactoryMesh(installation, { now: () => NOW_MS });
    const error = await factoryRejection(ensureFactoryMesh(installation, { now: () => NOW_MS + 31 * 24 * 60 * 60 * 1_000 }));
    expect(error.code).toBe("mesh_token_expired");
    expect(error.message).toBe("Mesh token mesh-orchestrator.token has expired; rotate the installation's deployment step.");
  });

  test("a token that is not a JWT, or has no expiry, is refused as mesh_token_invalid", async () => {
    await ensureFactoryMesh(installation, { now: () => NOW_MS });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const token of ["not-a-token", `${encode({})}.${Buffer.from("{broken").toString("base64url")}.x`, `${encode({})}.${encode(null)}.x`, `${encode({})}.${encode({ exp: "soon" })}.x`]) {
      await writeModeFile(secret(FACTORY_MESH_FILES.orchestratorToken), `${token}\n`);
      const error = await factoryRejection(ensureFactoryMesh(installation, { now: () => NOW_MS }));
      expect(error.code).toBe("mesh_token_invalid");
      expect(error.message).toBe("Mesh token mesh-orchestrator.token has no expiry.");
    }
  });

  test("an unsafe token file is refused as unsafe, not reported as a malformed token", async () => {
    await ensureFactoryMesh(installation, { now: () => NOW_MS });
    await chmod(secret(FACTORY_MESH_FILES.orchestratorToken), 0o644);
    expect((await factoryRejection(ensureFactoryMesh(installation, { now: () => NOW_MS }))).message).toBe("Provisioner secret file mesh-orchestrator.token must be private and owned by this user.");
  });

  test("a certificate for another identity under the right authority is refused", async () => {
    await ensureFactoryMesh(installation);
    await writeModeFile(secret(FACTORY_MESH_FILES.orchestratorCertificate), await text(secret(FACTORY_MESH_FILES.harnessCertificate)));
    expect((await factoryRejection(ensureFactoryMesh(installation))).code).toBe("mesh_certificate_invalid");
  });

  test("a tampered certificate body is refused", async () => {
    await ensureFactoryMesh(installation);
    const pem = await text(secret(FACTORY_MESH_FILES.serverCertificate));
    const der = certificate(pem).raw;
    der[der.length - 10] = der[der.length - 10]! ^ 0xff;
    const tampered = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
    await writeModeFile(secret(FACTORY_MESH_FILES.serverCertificate), tampered);
    expect((await factoryRejection(ensureFactoryMesh(installation))).code).toBe("mesh_certificate_invalid");
  });

  test("two installations' meshes do not trust each other", async () => {
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    await Promise.all([ensureFactoryMesh(installation), ensureFactoryMesh(other)]);
    const mine = certificate(await text(operator(FACTORY_MESH_OPERATOR_FILES.caCertificate)));
    const theirs = certificate(await text(secret(FACTORY_MESH_FILES.harnessCertificate, other)));
    expect(theirs.verify(mine.publicKey)).toBe(false);
    const token = await text(secret(FACTORY_MESH_FILES.orchestratorToken, other));
    expect(claimsUnder(await text(secret(FACTORY_MESH_FILES.tokenPublicKey)), token)).toBeUndefined();
  });

  test("a failing command runner stops the mesh before any authority file is written", async () => {
    const failing: FactoryCommandRunner = async (command, args) => { throw new FactoryProvisioningError("certificate_issue_failed", `${command} ${args[0]} exited 1`); };
    const error = await factoryRejection(ensureFactoryMesh(installation, { run: failing }));
    expect(error.code).toBe("certificate_issue_failed");
    expect(await readdir(installation.operatorDirectory)).toEqual([]);
    expect(await readdir(installation.secretDirectory)).toEqual([]);
  });

  test("a runner that fails at the first leaf leaves the authority and no half-written leaf", async () => {
    let calls = 0;
    const failing: FactoryCommandRunner = async (command, args) => {
      calls += 1;
      if (calls > 2) throw new FactoryProvisioningError("certificate_issue_failed", "openssl x509 exited 1");
      await factorySpawnRunner(command, args);
    };
    expect((await factoryRejection(ensureFactoryMesh(installation, { run: failing }))).code).toBe("certificate_issue_failed");
    expect((await readdir(installation.operatorDirectory)).sort()).toEqual([FACTORY_MESH_OPERATOR_FILES.caCertificate, FACTORY_MESH_OPERATOR_FILES.caKey].sort());
    expect(await readdir(installation.secretDirectory)).toEqual([FACTORY_MESH_FILES.caCertificate]);
    await ensureFactoryMesh(installation);
    expect(certificate(await text(secret(FACTORY_MESH_FILES.serverCertificate))).subject).toBe("CN=localhost");
  });

  for (const file of [FACTORY_MESH_FILES.attemptTokenSecret, FACTORY_MESH_FILES.harnessCertificate]) {
    test(`an unsafe existing ${file} is refused rather than trusted or replaced`, async () => {
      await ensureFactoryMesh(installation);
      const before = await text(secret(file));
      await chmod(secret(file), 0o644);
      expect((await factoryRejection(ensureFactoryMesh(installation))).message).toMatch(/^(Private file must be owned, private, regular, and bounded\.|Provisioner secret file .+ must be private and owned by this user\.)$/);
      expect(await text(secret(file))).toBe(before);
    });
  }
});

describe("rotateFactoryMesh", () => {
  test("re-mints every token and leaf under the same authority; the certificates match their new keys", async () => {
    const created = await ensureFactoryMesh(installation, { now: () => NOW_MS });
    const before = await snapshot(installation.secretDirectory);
    const operatorBefore = await snapshot(installation.operatorDirectory);
    const later = NOW_MS + 20 * 24 * 60 * 60 * 1_000;
    const rotated = await rotateFactoryMesh(installation, { now: () => later });
    const after = await snapshot(installation.secretDirectory);
    expect(created.tokensExpireAtMs).toBe(NOW_MS + 30 * 24 * 60 * 60 * 1_000);
    expect(rotated.tokensExpireAtMs).toBe(later + 30 * 24 * 60 * 60 * 1_000);
    expect(Object.isFrozen(rotated)).toBe(true);
    for (const file of [FACTORY_MESH_FILES.orchestratorToken, FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, FACTORY_MESH_FILES.harnessCertificate, FACTORY_MESH_FILES.harnessKey, FACTORY_MESH_FILES.orchestratorCertificate, FACTORY_MESH_FILES.orchestratorKey]) {
      expect(after[file]).not.toBe(before[file]);
      expect((await stat(secret(file))).mode & 0o777).toBe(0o600);
    }
    for (const file of [FACTORY_MESH_FILES.caCertificate, FACTORY_MESH_FILES.tokenPublicKey, FACTORY_MESH_FILES.attemptTokenSecret]) expect(after[file]).toBe(before[file]);
    expect(await snapshot(installation.operatorDirectory)).toEqual(operatorBefore);
    const ca = certificate(await text(operator(FACTORY_MESH_OPERATOR_FILES.caCertificate)));
    for (const [cert, key] of [[FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey], [FACTORY_MESH_FILES.harnessCertificate, FACTORY_MESH_FILES.harnessKey], [FACTORY_MESH_FILES.orchestratorCertificate, FACTORY_MESH_FILES.orchestratorKey]] as const) {
      const leaf = certificate(after[cert]!);
      expect(leaf.verify(ca.publicKey)).toBe(true);
      expect(leaf.checkPrivateKey(createPrivateKey(after[key]!))).toBe(true);
    }
    const claims = claimsUnder(after[FACTORY_MESH_FILES.tokenPublicKey]!, after[FACTORY_MESH_FILES.orchestratorToken]!);
    expect(claims?.claims.exp).toBe(Math.floor(later / 1_000) + 30 * 24 * 60 * 60);
    // The rotated mesh is what a rerun now proves, byte for byte.
    await ensureFactoryMesh(installation, { now: () => later });
    expect(await snapshot(installation.secretDirectory)).toEqual(after);
  });

  test("rotation repairs an expired mesh", async () => {
    await ensureFactoryMesh(installation, { now: () => NOW_MS });
    const expired = NOW_MS + 40 * 24 * 60 * 60 * 1_000;
    expect((await factoryRejection(ensureFactoryMesh(installation, { now: () => expired }))).code).toBe("mesh_token_expired");
    await rotateFactoryMesh(installation, { now: () => expired });
    expect((await ensureFactoryMesh(installation, { now: () => expired })).tokensExpireAtMs).toBe(expired + 30 * 24 * 60 * 60 * 1_000);
  });

  test("uses the real clock by default", async () => {
    await ensureFactoryMesh(installation);
    const before = Date.now();
    const rotated = await rotateFactoryMesh(installation);
    expect(rotated.tokensExpireAtMs).toBeGreaterThanOrEqual(Math.floor(before / 1_000) * 1_000 + 30 * 24 * 60 * 60 * 1_000);
  });

  test("a mesh that was never created cannot be rotated", async () => {
    expect((await factoryRejection(rotateFactoryMesh(installation))).code).toBe("ENOENT");
  });
});
