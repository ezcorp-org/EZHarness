import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, makeFactoryTestInstallation, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import { loadFactoryTemporalPayloadCodec } from "../file-key-wraps";
import type { FactoryInstallationContext, FactoryStepResources } from "./installation";
import { FactoryProvisioningError } from "./steps";
import { FACTORY_APPLICATION_SECRET_FILES, FACTORY_ESCROW_WRAPS, FACTORY_KEY_FILES, FactorySecretsStep, assertFactoryMasterKeyIsRaw, escrowFactoryArchiveKey, factoryMasterKeyId, type FactorySecretDigestRegistry } from "./secrets";

let root: string;
let installation: FactoryInstallationContext;

beforeEach(async () => {
  root = await makeFactoryPrivateRoot();
  installation = makeFactoryTestInstallation(root);
});
afterEach(async () => { await removeFactoryPrivateRoot(root); });

/** The fleet's digest ledger: which tenant holds which secret digest. */
class FleetRegistry implements FactorySecretDigestRegistry {
  readonly holders = new Map<string, string>();
  readonly asked: Array<[string, readonly string[]]> = [];
  async conflicts(tenantId: string, digests: readonly string[]): Promise<readonly string[]> {
    this.asked.push([tenantId, digests]);
    return [...new Set(digests.map((value) => this.holders.get(value)).filter((holder): holder is string => holder !== undefined && holder !== tenantId))];
  }
  hold(tenantId: string, resources: FactoryStepResources): void {
    for (const key of ["jwtSecretDigest", "encryptionSecretDigest", "saltDigest", "masterKeyDigest"]) this.holders.set(resources[key]!, tenantId);
  }
}

function makeStep(grantableRoots: (installation_: FactoryInstallationContext) => readonly string[] = () => [join(root, "workspaces")]) {
  const registry = new FleetRegistry();
  return { step: new FactorySecretsStep({ registry, grantableRoots }), registry };
}

const secretPath = (name: string, target = installation) => join(target.secretDirectory, name);
const masterPath = (target = installation) => join(target.operatorDirectory, FACTORY_KEY_FILES.master);
const sha = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const WORKFLOW = { type: "workflow" as const, namespace: "tenant-01.fleet-a", workflowId: "wf-1" };

function codecFor(target: FactoryInstallationContext, wrappedKeyFilePath = secretPath(FACTORY_KEY_FILES.wraps, target)) {
  return loadFactoryTemporalPayloadCodec({ installationId: target.installationId, tenantId: target.tenantId, wrappedKeyFilePath, masterKeyFilePath: masterPath(target), masterKeyId: factoryMasterKeyId(target), grantableRoots: [join(root, "workspaces")] });
}

async function applicationSecret(name: string): Promise<string> { return (await readFile(secretPath(name), "utf8")).trim(); }

describe("assertFactoryMasterKeyIsRaw", () => {
  const raw = randomBytes(32);
  const unrelated = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  function refusal(masterKey: Uint8Array, secrets: readonly string[]): string | undefined {
    try { assertFactoryMasterKeyIsRaw(masterKey, secrets); return undefined; }
    catch (error) { expect(error).toBeInstanceOf(FactoryProvisioningError); return (error as FactoryProvisioningError).code; }
  }

  test("accepts 32 raw random bytes unrelated to the application secrets", () => {
    expect(refusal(raw, unrelated)).toBeUndefined();
    expect(refusal(raw, [])).toBeUndefined();
  });

  test("refuses anything but exactly 32 bytes", () => {
    expect(refusal(randomBytes(31), [])).toBe("master_key_invalid");
    expect(refusal(randomBytes(33), [])).toBe("master_key_invalid");
    expect(refusal(new Uint8Array(0), [])).toBe("master_key_invalid");
  });

  test("a 43-character base64url application secret is exactly 32 bytes of key material when decoded", () => {
    expect(raw.toString("base64url")).toHaveLength(43);
  });

  const encodings: Array<[string, (bytes: Buffer) => string]> = [
    ["base64url", (bytes) => bytes.toString("base64url")],
    ["base64", (bytes) => bytes.toString("base64")],
    ["hex", (bytes) => bytes.toString("hex")],
    ["base64url with a trailing newline", (bytes) => `${bytes.toString("base64url")}\n`],
  ];
  for (const [name, encode] of encodings) {
    test(`refuses a master key that is the ${name} decoding of an application secret`, () => {
      expect(refusal(raw, [unrelated[0]!, encode(raw)])).toBe("master_key_is_application_secret");
    });
  }

  test("refuses a master key whose text is an application secret", () => {
    const printable = Buffer.from("A".repeat(32));
    expect(refusal(printable, ["A".repeat(32)])).toBe("master_key_is_application_secret");
  });

  test("refuses printable 32-byte text that matches no secret", () => {
    expect(refusal(Buffer.from("abcdefghijklmnopqrstuvwxyz012345"), unrelated)).toBe("master_key_is_text");
    expect(refusal(Buffer.from("abcdefghijklmnop+/_=-ABCDEFGHIJK"), unrelated)).toBe("master_key_is_text");
  });

  test("any all-printable key is refused, including text outside an encoding alphabet and a 31-character secret with a newline", () => {
    expect(refusal(Buffer.from("this is not an encoded secret !!"), unrelated)).toBe("master_key_is_text");
    expect(refusal(Buffer.from(`${"a".repeat(31)}\n`), unrelated)).toBe("master_key_is_text");
  });
});

describe("FactorySecretsStep.ensure", () => {
  test("generates distinct application secrets, a raw master key, and a wrap the Node loader boots from", async () => {
    const { step, registry } = makeStep();
    const resources = await step.ensure(installation);
    const jwt = await applicationSecret(FACTORY_APPLICATION_SECRET_FILES.jwt);
    const encryption = await applicationSecret(FACTORY_APPLICATION_SECRET_FILES.encryption);
    const salt = await applicationSecret(FACTORY_APPLICATION_SECRET_FILES.salt);
    const master = await readFile(masterPath());
    expect(jwt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(encryption).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwt).not.toBe(encryption);
    expect(salt).toMatch(/^[a-f0-9]{32}$/);
    expect(master.byteLength).toBe(32);
    expect(resources).toEqual({
      jwtSecretPath: secretPath(FACTORY_APPLICATION_SECRET_FILES.jwt),
      encryptionSecretPath: secretPath(FACTORY_APPLICATION_SECRET_FILES.encryption),
      saltPath: secretPath(FACTORY_APPLICATION_SECRET_FILES.salt),
      wrappedKeyFilePath: secretPath(FACTORY_KEY_FILES.wraps),
      masterKeyFilePath: masterPath(),
      masterKeyId: "master-inst-tenant-01-v1",
      jwtSecretDigest: sha(jwt),
      encryptionSecretDigest: sha(encryption),
      saltDigest: sha(salt),
      masterKeyDigest: sha(master),
    });
    expect(Object.isFrozen(resources)).toBe(true);
    expect(registry.asked).toEqual([["tenant-01", [sha(jwt), sha(encryption), sha(salt), sha(master)]]]);
    for (const path of [...Object.values(FACTORY_APPLICATION_SECRET_FILES).map((name) => secretPath(name)), secretPath(FACTORY_KEY_FILES.wraps), masterPath()]) expect((await stat(path)).mode & 0o777).toBe(0o600);
    const wraps = JSON.parse(await readFile(secretPath(FACTORY_KEY_FILES.wraps), "utf8"));
    expect(wraps).toMatchObject({ schemaVersion: "factory.key-wraps.v1", installationId: "inst-tenant-01", wraps: [{ installationId: "inst-tenant-01", wrapVersion: 1, masterKeyId: "master-inst-tenant-01-v1" }] });
    const codec = await codecFor(installation);
    const payload = { metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from("hello") };
    const [encoded] = await codec.encode([payload], WORKFLOW);
    expect(Buffer.from(encoded!.data!).includes(Buffer.from("hello"))).toBe(false);
    expect(Buffer.from((await codec.decode([encoded!], WORKFLOW))[0]!.data!).toString()).toBe("hello");
  });

  test("a rerun is write-once: every file and the wrap are unchanged", async () => {
    const { step } = makeStep();
    const first = await step.ensure(installation);
    const wraps = await readFile(secretPath(FACTORY_KEY_FILES.wraps));
    expect(await step.ensure(installation)).toEqual(first);
    expect(await readFile(secretPath(FACTORY_KEY_FILES.wraps))).toEqual(wraps);
  });

  test("after a crash that lost the application secrets, a rerun completes and keeps the master key", async () => {
    const { step } = makeStep();
    const first = await step.ensure(installation);
    await rm(secretPath(FACTORY_APPLICATION_SECRET_FILES.salt));
    const second = await step.ensure(installation);
    expect(second.masterKeyDigest).toBe(first.masterKeyDigest);
    expect(second.jwtSecretDigest).toBe(first.jwtSecretDigest);
    expect(second.saltDigest).not.toBe(first.saltDigest);
  });

  test("a corrupt wrap file is refused, never replaced", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    await writeModeFile(secretPath(FACTORY_KEY_FILES.wraps), JSON.stringify({ schemaVersion: "factory.key-wraps.v1", installationId: "inst-tenant-01", wraps: [] }));
    expect((await factoryRejection(step.ensure(installation))).code).toBe("factory_key_invalid");
    expect(await readFile(secretPath(FACTORY_KEY_FILES.wraps), "utf8")).toContain("\"wraps\":[]");
  });

  test("a master key under a grantable root is refused before any wrap is written", async () => {
    const { step } = makeStep(() => [join(root, "operator")]);
    expect((await factoryRejection(step.ensure(installation))).code).toBe("factory_key_unsafe");
    expect(await Bun.file(secretPath(FACTORY_KEY_FILES.wraps)).exists()).toBe(false);
  });

  test("two tenants provisioned concurrently get unrelated secrets and data keys", async () => {
    const { step, registry } = makeStep();
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    const [mine, theirs] = await Promise.all([step.ensure(installation), step.ensure(other)]);
    for (const key of ["jwtSecretDigest", "encryptionSecretDigest", "saltDigest", "masterKeyDigest"]) expect(mine[key]).not.toBe(theirs[key]);
    expect(registry.asked.map(([tenant]) => tenant).sort()).toEqual(["tenant-01", "tenant-02"]);
    const [encoded] = await (await codecFor(installation)).encode([{ metadata: {}, data: Buffer.from("x") }], WORKFLOW);
    expect((await factoryRejection((await codecFor(other)).decode([encoded!], WORKFLOW))).code).toBe("factory_decryption_failed");
  });
});

describe("FactorySecretsStep.verify", () => {
  async function ensured() {
    const made = makeStep();
    return { ...made, resources: await made.step.ensure(installation) };
  }

  test("refuses a secret another tenant in the fleet already holds, naming that tenant", async () => {
    const { step, registry, resources } = await ensured();
    registry.hold("tenant-07", { jwtSecretDigest: resources.jwtSecretDigest! });
    const error = await factoryRejection(step.verify(installation, resources));
    expect(error.code).toBe("application_secret_shared");
    expect(error.message).toBe("A secret of this installation is also held by tenant-07.");
  });

  test("a tenant's own digests are not a conflict", async () => {
    const { step, registry, resources } = await ensured();
    registry.hold("tenant-01", resources);
    expect(await step.verify(installation, resources)).toBeUndefined();
  });

  test("a templated secret copied into a second tenant is refused there", async () => {
    const { step, registry, resources } = await ensured();
    registry.hold("tenant-01", resources);
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    await mkdir(other.secretDirectory, { mode: 0o700 });
    const copied = await readFile(secretPath(FACTORY_APPLICATION_SECRET_FILES.encryption));
    await writeModeFile(secretPath(FACTORY_APPLICATION_SECRET_FILES.encryption, other), copied);
    const error = await factoryRejection(step.ensure(other));
    expect(error.code).toBe("application_secret_shared");
    expect(error.message).toContain("tenant-01");
  });

  const mismatches = ["jwtSecretDigest", "encryptionSecretDigest", "saltDigest", "masterKeyDigest"];
  for (const key of mismatches) {
    test(`refuses a recorded ${key} that does not match the file on disk`, async () => {
      const { step, resources } = await ensured();
      expect((await factoryRejection(step.verify(installation, { ...resources, [key]: sha("other") }))).code).toBe("secrets_resource_mismatch");
    });
  }

  const invalid: Array<[string, string, string]> = [
    ["a short JWT secret", FACTORY_APPLICATION_SECRET_FILES.jwt, "short\n"],
    ["a 44-character encryption secret", FACTORY_APPLICATION_SECRET_FILES.encryption, `${"A".repeat(44)}\n`],
    ["a padded base64 JWT secret", FACTORY_APPLICATION_SECRET_FILES.jwt, `${"A".repeat(42)}=\n`],
    ["an uppercase salt", FACTORY_APPLICATION_SECRET_FILES.salt, `${"A".repeat(32)}\n`],
    ["a 31-character salt", FACTORY_APPLICATION_SECRET_FILES.salt, `${"a".repeat(31)}\n`],
  ];
  for (const [name, file, content] of invalid) {
    test(`refuses ${name}`, async () => {
      const { step, resources } = await ensured();
      await writeModeFile(secretPath(file), content);
      expect((await factoryRejection(step.verify(installation, resources))).code).toBe("application_secret_invalid");
    });
  }

  test("refuses a JWT secret equal to the encryption secret", async () => {
    const { step, resources } = await ensured();
    await writeModeFile(secretPath(FACTORY_APPLICATION_SECRET_FILES.jwt), await readFile(secretPath(FACTORY_APPLICATION_SECRET_FILES.encryption)));
    expect((await factoryRejection(step.verify(installation, resources))).message).toBe("The JWT and encryption secrets must differ.");
  });

  test("refuses a master key that is the decoded JWT secret", async () => {
    const { step, resources } = await ensured();
    await writeModeFile(masterPath(), Buffer.from(await applicationSecret(FACTORY_APPLICATION_SECRET_FILES.jwt), "base64url"));
    expect((await factoryRejection(step.verify(installation, resources))).code).toBe("master_key_is_application_secret");
  });

  // The step's own check names the mistake; the Node loader behind it refuses the rest.
  const grantable: Array<[string, (target: FactoryInstallationContext) => string, string]> = [
    ["the operator directory itself", (target) => target.operatorDirectory, "secrets_inside_grantable_root"],
    ["a parent of the operator directory", () => join(root, "operator"), "secrets_inside_grantable_root"],
    ["a parent of the secret directory", () => join(root, "secrets"), "secrets_inside_grantable_root"],
    ["a parent of the secret directory with trailing slashes", () => `${join(root, "secrets")}//`, "secrets_inside_grantable_root"],
    ["the operator directory with a trailing slash", (target) => `${target.operatorDirectory}/`, "secrets_inside_grantable_root"],
    ["the secret directory itself", (target) => target.secretDirectory, "secrets_inside_grantable_root"],
  ];
  for (const [name, grant, code] of grantable) {
    test(`refuses secrets when ${name} is grantable`, async () => {
      const { resources } = await ensured();
      const strict = new FactorySecretsStep({ registry: new FleetRegistry(), grantableRoots: (target) => [join(root, "workspaces"), grant(target)] });
      expect((await factoryRejection(strict.verify(installation, resources))).code).toBe(code);
    });
  }

  test("a grantable sibling that merely shares a name prefix is not a refusal", async () => {
    const { resources } = await ensured();
    const sibling = new FactorySecretsStep({ registry: new FleetRegistry(), grantableRoots: () => [join(root, "operator", "tenant-0"), join(root, "secret")] });
    expect(await sibling.verify(installation, resources)).toBeUndefined();
  });

  test("refuses a wrap the Node loader cannot open", async () => {
    const { step, resources } = await ensured();
    await chmod(secretPath(FACTORY_KEY_FILES.wraps), 0o644);
    expect((await factoryRejection(step.verify(installation, resources))).code).toBe("factory_key_unsafe");
  });
});

describe("FactorySecretsStep.teardown and rotate", () => {
  test("teardown escrows the wrap, destroys the application secrets and the wrap, keeps the master key, and succeeds twice", async () => {
    const { step } = makeStep();
    const resources = await step.ensure(installation);
    const wraps = await readFile(secretPath(FACTORY_KEY_FILES.wraps));
    await step.teardown(installation);
    for (const name of [...Object.values(FACTORY_APPLICATION_SECRET_FILES), FACTORY_KEY_FILES.wraps]) expect(await Bun.file(secretPath(name)).exists()).toBe(false);
    expect(await readFile(join(installation.operatorDirectory, FACTORY_ESCROW_WRAPS))).toEqual(wraps);
    expect(sha(await readFile(masterPath()))).toBe(resources.masterKeyDigest!);
    await step.teardown(installation);
    expect(await Bun.file(masterPath()).exists()).toBe(true);
    expect(await readFile(join(installation.operatorDirectory, FACTORY_ESCROW_WRAPS))).toEqual(wraps);
  });

  test("teardown then purge keeps an archive written before teardown decryptable", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    const [encoded] = await (await codecFor(installation)).encode([{ metadata: {}, data: Buffer.from("archived") }], WORKFLOW);
    await step.teardown(installation);
    await escrowFactoryArchiveKey(installation);
    const escrowed = await codecFor(installation, join(installation.operatorDirectory, FACTORY_ESCROW_WRAPS));
    expect(Buffer.from((await escrowed.decode([encoded!], WORKFLOW))[0]!.data!).toString()).toBe("archived");
    expect((await factoryRejection(stat(installation.secretDirectory))).code).toBe("ENOENT");
  });

  test("teardown refuses and deletes nothing when neither the wrap nor its escrow exists", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    await rm(secretPath(FACTORY_KEY_FILES.wraps));
    expect((await factoryRejection(step.teardown(installation))).code).toBe("secrets_escrow_missing");
    expect(await Bun.file(secretPath(FACTORY_APPLICATION_SECRET_FILES.jwt)).exists()).toBe(true);
  });

  test("rotate replaces only the JWT secret and returns digests that verify", async () => {
    const { step } = makeStep();
    const before = await step.ensure(installation);
    const oldJwt = await applicationSecret(FACTORY_APPLICATION_SECRET_FILES.jwt);
    const after = await step.rotate(installation);
    expect(await applicationSecret(FACTORY_APPLICATION_SECRET_FILES.jwt)).not.toBe(oldJwt);
    expect(after).toEqual({ ...before, jwtSecretDigest: sha(await applicationSecret(FACTORY_APPLICATION_SECRET_FILES.jwt)) });
    expect((await stat(secretPath(FACTORY_APPLICATION_SECRET_FILES.jwt))).mode & 0o777).toBe(0o600);
    expect(await step.verify(installation, after)).toBeUndefined();
    expect((await factoryRejection(step.verify(installation, before))).code).toBe("secrets_resource_mismatch");
  });
});

describe("escrowFactoryArchiveKey", () => {
  test("keeps the master key and an escrow copy of the wrap, removes the invitation and the whole secret directory", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    const wraps = await readFile(secretPath(FACTORY_KEY_FILES.wraps));
    const master = await readFile(masterPath());
    await writeModeFile(join(installation.operatorDirectory, "first-admin-invitation.json"), "{}");
    const [encoded] = await (await codecFor(installation)).encode([{ metadata: {}, data: Buffer.from("archived") }], WORKFLOW);
    await escrowFactoryArchiveKey(installation);
    const escrow = join(installation.operatorDirectory, "escrow-wraps.json");
    expect(await readFile(escrow)).toEqual(wraps);
    expect((await stat(escrow)).mode & 0o777).toBe(0o600);
    expect(await readFile(masterPath())).toEqual(master);
    expect(await Bun.file(join(installation.operatorDirectory, "first-admin-invitation.json")).exists()).toBe(false);
    expect((await factoryRejection(stat(installation.secretDirectory))).code).toBe("ENOENT");
    const escrowed = await codecFor(installation, escrow);
    expect(Buffer.from((await escrowed.decode([encoded!], WORKFLOW))[0]!.data!).toString()).toBe("archived");
  });

  test("a rerun after the secret directory is gone keeps the escrow copy and succeeds", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    await escrowFactoryArchiveKey(installation);
    const escrow = await readFile(join(installation.operatorDirectory, "escrow-wraps.json"));
    await escrowFactoryArchiveKey(installation);
    expect(await readFile(join(installation.operatorDirectory, "escrow-wraps.json"))).toEqual(escrow);
    expect((await factoryRejection(stat(installation.secretDirectory))).code).toBe("ENOENT");
  });

  test("purge refuses and keeps the secret directory when the wrap and its escrow are both gone", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    await rm(secretPath(FACTORY_KEY_FILES.wraps));
    expect((await factoryRejection(escrowFactoryArchiveKey(installation))).code).toBe("secrets_escrow_missing");
    expect(await Bun.file(secretPath(FACTORY_APPLICATION_SECRET_FILES.jwt)).exists()).toBe(true);
  });

  test("an unreadable escrow copy is refused, not taken as missing", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    await step.teardown(installation);
    await chmod(join(installation.operatorDirectory, FACTORY_ESCROW_WRAPS), 0o644);
    expect((await factoryRejection(escrowFactoryArchiveKey(installation))).message).toBe("Private file must be owned, private, regular, and bounded.");
  });

  test("without a master key it refuses and deletes nothing", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    await rm(masterPath());
    expect((await factoryRejection(escrowFactoryArchiveKey(installation))).code).toBe("ENOENT");
    expect(await Bun.file(secretPath(FACTORY_KEY_FILES.wraps)).exists()).toBe(true);
  });

  test("an unsafe wrap file is refused rather than skipped", async () => {
    const { step } = makeStep();
    await step.ensure(installation);
    await chmod(secretPath(FACTORY_KEY_FILES.wraps), 0o644);
    expect((await factoryRejection(escrowFactoryArchiveKey(installation))).message).toBe("Private file must be owned, private, regular, and bounded.");
    expect(await Bun.file(join(installation.operatorDirectory, "escrow-wraps.json")).exists()).toBe(false);
  });
});
