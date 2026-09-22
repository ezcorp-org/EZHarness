import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import type { FactoryInstallationContext } from "./installation";
import {
  FACTORY_BOOTSTRAP_INVITATION_FILE,
  FACTORY_BOOTSTRAP_INVITATION_SCHEMA,
  FACTORY_INVITATION_LIFETIME_MS,
  FACTORY_INVITATION_OUTBOX_FILE,
  FactoryBootstrapInvitationError,
  FactoryInvitationStep,
  factoryInvitationTokenDigest,
  loadFactoryBootstrapInvitation,
  parseFactoryBootstrapInvitation,
  verifyFactoryBootstrapInvitation,
  type FactoryBootstrapInvitation,
  type FactoryInvitationOutbox,
} from "./invitation";
import { replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

const TOKEN = "A".repeat(43);
const NOW = 1_800_000_000_000;

function invitation(overrides: Partial<FactoryBootstrapInvitation> = {}): FactoryBootstrapInvitation {
  return {
    schemaVersion: FACTORY_BOOTSTRAP_INVITATION_SCHEMA,
    installationId: "inst-1",
    tenantId: "tenant-01",
    invitationId: "invite-1",
    administratorEmail: "admin@example.com",
    tokenDigest: factoryInvitationTokenDigest(TOKEN),
    expiresAtMs: NOW + 1_000,
    ...overrides,
  };
}

function code(work: () => unknown): string {
  try { work(); }
  catch (error) {
    expect(error).toBeInstanceOf(FactoryBootstrapInvitationError);
    expect((error as Error).message).toBe((error as FactoryBootstrapInvitationError).code);
    return (error as FactoryBootstrapInvitationError).code;
  }
  return "accepted";
}

async function rejection(work: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await work; }
  catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected a rejection");
}

describe("factoryInvitationTokenDigest", () => {
  test("is sha256 hex with a prefix", () => {
    expect(factoryInvitationTokenDigest(TOKEN)).toBe(`sha256:${createHash("sha256").update(TOKEN).digest("hex")}`);
    expect(factoryInvitationTokenDigest("a")).not.toBe(factoryInvitationTokenDigest("b"));
  });
});

describe("parseFactoryBootstrapInvitation", () => {
  test("returns a frozen copy of a valid record", () => {
    const record = invitation();
    const parsed = parseFactoryBootstrapInvitation(record, "inst-1");
    expect(parsed).toEqual(record);
    expect(parsed).not.toBe(record);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseFactoryBootstrapInvitation(invitation({ expiresAtMs: 0 }), "inst-1").expiresAtMs).toBe(0);
  });

  test("refuses every malformed or foreign record as unavailable", () => {
    const { tenantId: _omitted, ...missingTenant } = invitation();
    const bad: unknown[] = [
      null, undefined, "text", 5, [],
      missingTenant,
      { ...invitation(), token: TOKEN },
      invitation({ schemaVersion: "factory.bootstrap-invitation.v2" as never }),
      invitation({ installationId: "inst-2" }),
      invitation({ tenantId: "" }),
      invitation({ tenantId: 1 as never }),
      invitation({ invitationId: "" }),
      invitation({ invitationId: null as never }),
      invitation({ administratorEmail: "no-at-sign" }),
      invitation({ administratorEmail: 3 as never }),
      invitation({ tokenDigest: "sha256:XYZ" }),
      invitation({ tokenDigest: `sha512:${"a".repeat(64)}` }),
      invitation({ tokenDigest: 1 as never }),
      invitation({ expiresAtMs: -1 }),
      invitation({ expiresAtMs: 1.5 }),
      invitation({ expiresAtMs: "1" as never }),
      invitation({ expiresAtMs: Number.MAX_SAFE_INTEGER + 1 }),
    ];
    for (const value of bad) expect(code(() => parseFactoryBootstrapInvitation(value, "inst-1"))).toBe("bootstrap_invitation_unavailable");
  });
});

describe("verifyFactoryBootstrapInvitation", () => {
  const record = invitation();

  test("accepts the right token and email before expiry", () => {
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "admin@example.com" }, NOW))).toBe("accepted");
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "admin@example.com" }, record.expiresAtMs - 1))).toBe("accepted");
  });

  test("compares the email case-insensitively after trimming", () => {
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "  ADMIN@Example.COM " }, NOW))).toBe("accepted");
    expect(code(() => verifyFactoryBootstrapInvitation(invitation({ administratorEmail: "Admin@Example.com" }), { token: TOKEN, email: "admin@example.com" }, NOW))).toBe("accepted");
  });

  test("a missing or empty token is required", () => {
    for (const token of [undefined, null, "", 42, {}]) expect(code(() => verifyFactoryBootstrapInvitation(record, { token, email: "admin@example.com" }, NOW))).toBe("bootstrap_invitation_required");
  });

  test("a malformed or wrong token is invalid", () => {
    for (const token of ["short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}+`, "B".repeat(43)]) {
      expect(code(() => verifyFactoryBootstrapInvitation(record, { token, email: "admin@example.com" }, NOW))).toBe("bootstrap_invitation_invalid");
    }
  });

  test("a digest of a different length is invalid, not a crash", () => {
    expect(code(() => verifyFactoryBootstrapInvitation(invitation({ tokenDigest: "sha256:short" }), { token: TOKEN, email: "admin@example.com" }, NOW))).toBe("bootstrap_invitation_invalid");
  });

  test("the token expires at exactly expiresAtMs", () => {
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "admin@example.com" }, record.expiresAtMs))).toBe("bootstrap_invitation_expired");
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "admin@example.com" }, record.expiresAtMs + 60_000))).toBe("bootstrap_invitation_expired");
  });

  test("a different email is refused after the token checks pass", () => {
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "other@example.com" }, NOW))).toBe("bootstrap_invitation_email_mismatch");
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "admin@example.com.evil" }, NOW))).toBe("bootstrap_invitation_email_mismatch");
  });

  test("refusal order: an invalid token wins over expiry and email", () => {
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: "B".repeat(43), email: "other@example.com" }, record.expiresAtMs + 1))).toBe("bootstrap_invitation_invalid");
    expect(code(() => verifyFactoryBootstrapInvitation(record, { token: TOKEN, email: "other@example.com" }, record.expiresAtMs + 1))).toBe("bootstrap_invitation_expired");
  });
});

describe("with private directories", () => {
  let root: string;
  let installation: FactoryInstallationContext;

  beforeEach(async () => {
    root = await makeFactoryPrivateRoot();
    installation = {
      tenantId: "tenant-01",
      hostname: "tenant-01.factory.example",
      administratorEmail: "First.Admin@Example.com",
      fleetId: "fleet-a",
      installationId: "inst-1",
      invitationId: "invite-1",
      productDatabase: "factory_product_x",
      productRole: "factory_role_x",
      temporalNamespace: "tenant-01.fleet-a",
      secretDirectory: join(root, "secrets", "tenant-01"),
      operatorDirectory: join(root, "operator", "tenant-01"),
    };
  });

  afterEach(async () => { await removeFactoryPrivateRoot(root); });

  const invitationPath = () => join(installation.secretDirectory, FACTORY_BOOTSTRAP_INVITATION_FILE);
  const outboxPath = () => join(installation.operatorDirectory, FACTORY_INVITATION_OUTBOX_FILE);
  const outbox = async () => JSON.parse(await readFile(outboxPath(), "utf8")) as FactoryInvitationOutbox;

  describe("loadFactoryBootstrapInvitation", () => {
    test("loads a private invitation file", async () => {
      await replaceFactoryPrivateFile(invitationPath(), JSON.stringify(invitation()));
      expect(await loadFactoryBootstrapInvitation(invitationPath(), "inst-1")).toEqual(invitation());
    });

    test("every unreadable, unsafe, or foreign file is unavailable", async () => {
      const cases: [string, string | Uint8Array, number][] = [
        ["open.json", JSON.stringify(invitation()), 0o644],
        ["not-json.json", "{", 0o600],
        ["bad-utf8.json", new Uint8Array([0xff]), 0o600],
        ["huge.json", " ".repeat(16 * 1024 + 1), 0o600],
      ];
      await replaceFactoryPrivateFile(join(root, "files", "keep"), "x");
      for (const [name, content, mode] of cases) {
        const path = await writeModeFile(join(root, "files", name), content, mode);
        expect(((await rejection(loadFactoryBootstrapInvitation(path, "inst-1"))) as FactoryBootstrapInvitationError).code).toBe("bootstrap_invitation_unavailable");
      }
      expect(((await rejection(loadFactoryBootstrapInvitation(join(root, "files", "absent.json"), "inst-1"))) as FactoryBootstrapInvitationError).code).toBe("bootstrap_invitation_unavailable");
      const foreign = await writeModeFile(join(root, "files", "foreign.json"), JSON.stringify(invitation({ installationId: "inst-2" })));
      expect(((await rejection(loadFactoryBootstrapInvitation(foreign, "inst-1"))) as FactoryBootstrapInvitationError).code).toBe("bootstrap_invitation_unavailable");
    });
  });

  describe("FactoryInvitationStep", () => {
    const step = (now = NOW, lifetimeMs = 60_000) => new FactoryInvitationStep({ now: () => now, lifetimeMs });

    test("is the invitation step and derives its paths from the installation", () => {
      const driver = step();
      expect(driver.step).toBe("invitation");
      expect(driver.paths(installation)).toEqual({ invitation: invitationPath(), outbox: outboxPath() });
    });

    test("issue writes a digest-only invitation and a token outbox, both private", async () => {
      const resources = await step().ensure(installation, undefined);
      const stored = await loadFactoryBootstrapInvitation(invitationPath(), "inst-1");
      const delivered = await outbox();
      expect(resources).toEqual({ invitationId: "invite-1", invitationPath: invitationPath(), outboxPath: outboxPath(), tokenDigest: stored.tokenDigest, expiresAtMs: String(NOW + 60_000) });
      expect(Object.isFrozen(resources)).toBe(true);
      expect(stored).toEqual({ schemaVersion: FACTORY_BOOTSTRAP_INVITATION_SCHEMA, installationId: "inst-1", tenantId: "tenant-01", invitationId: "invite-1", administratorEmail: "first.admin@example.com", tokenDigest: factoryInvitationTokenDigest(delivered.token), expiresAtMs: NOW + 60_000 });
      expect(delivered).toEqual({ schemaVersion: "factory.invitation-outbox.v1", installationId: "inst-1", invitationId: "invite-1", hostname: "tenant-01.factory.example", administratorEmail: "first.admin@example.com", token: delivered.token, expiresAtMs: NOW + 60_000 });
      expect(delivered.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await readFile(invitationPath(), "utf8")).not.toContain(delivered.token);
      expect((await stat(invitationPath())).mode & 0o777).toBe(0o600);
      expect((await stat(outboxPath())).mode & 0o777).toBe(0o600);
      expect((await stat(installation.operatorDirectory)).mode & 0o777).toBe(0o700);
    });

    test("the delivered token verifies for the invited email, in any case", async () => {
      await step().ensure(installation, undefined);
      const stored = await loadFactoryBootstrapInvitation(invitationPath(), "inst-1");
      const { token } = await outbox();
      expect(code(() => verifyFactoryBootstrapInvitation(stored, { token, email: "FIRST.ADMIN@example.com" }, NOW))).toBe("accepted");
      expect(code(() => verifyFactoryBootstrapInvitation(stored, { token, email: "someone@example.com" }, NOW))).toBe("bootstrap_invitation_email_mismatch");
    });

    test("the delivered token expires after the configured lifetime", async () => {
      await step(NOW, 1_000).ensure(installation, undefined);
      const stored = await loadFactoryBootstrapInvitation(invitationPath(), "inst-1");
      const { token } = await outbox();
      expect(code(() => verifyFactoryBootstrapInvitation(stored, { token, email: "first.admin@example.com" }, NOW + 999))).toBe("accepted");
      expect(code(() => verifyFactoryBootstrapInvitation(stored, { token, email: "first.admin@example.com" }, NOW + 1_000))).toBe("bootstrap_invitation_expired");
    });

    test("defaults to the real clock and a seven-day lifetime", async () => {
      const before = Date.now();
      const resources = await new FactoryInvitationStep().ensure(installation, undefined);
      const after = Date.now();
      const expiresAtMs = Number(resources.expiresAtMs);
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + FACTORY_INVITATION_LIFETIME_MS);
      expect(expiresAtMs).toBeLessThanOrEqual(after + FACTORY_INVITATION_LIFETIME_MS);
      expect(FACTORY_INVITATION_LIFETIME_MS).toBe(604_800_000);
    });

    test("a rerun with the recorded digest keeps the live invitation unchanged", async () => {
      const driver = step();
      const first = await driver.ensure(installation, undefined);
      const invitationBytes = await readFile(invitationPath(), "utf8");
      const outboxBytes = await readFile(outboxPath(), "utf8");
      const second = await step(NOW + 5_000).ensure(installation, first);
      expect(second).toEqual(first);
      expect(await readFile(invitationPath(), "utf8")).toBe(invitationBytes);
      expect(await readFile(outboxPath(), "utf8")).toBe(outboxBytes);
    });

    test("a rerun without a matching record issues a fresh token", async () => {
      const driver = step();
      const first = await driver.ensure(installation, undefined);
      const second = await driver.ensure(installation, { ...first, tokenDigest: "sha256:other" });
      expect(second.tokenDigest).not.toBe(first.tokenDigest);
      await driver.verify(installation, second);
    });

    test("verify accepts a consistent invitation and outbox, also concurrently", async () => {
      const driver = step();
      const resources = await driver.ensure(installation, undefined);
      await Promise.all(Array.from({ length: 8 }, () => driver.verify(installation, resources)));
      expect(await readdir(installation.operatorDirectory)).toEqual([FACTORY_INVITATION_OUTBOX_FILE]);
    });

    test("rotate replaces the token under the same invitation identity and the old token stops verifying", async () => {
      const first = await step().ensure(installation, undefined);
      const oldToken = (await outbox()).token;
      const rotated = await step(NOW + 10_000).rotate(installation);
      const newToken = (await outbox()).token;
      const stored = await loadFactoryBootstrapInvitation(invitationPath(), "inst-1");
      expect(rotated.invitationId).toBe(first.invitationId);
      expect(rotated.tokenDigest).not.toBe(first.tokenDigest);
      expect(rotated.expiresAtMs).toBe(String(NOW + 10_000 + 60_000));
      expect(newToken).not.toBe(oldToken);
      expect(code(() => verifyFactoryBootstrapInvitation(stored, { token: oldToken, email: "first.admin@example.com" }, NOW))).toBe("bootstrap_invitation_invalid");
      expect(code(() => verifyFactoryBootstrapInvitation(stored, { token: newToken, email: "first.admin@example.com" }, NOW))).toBe("accepted");
      await step().verify(installation, rotated);
      expect(((await rejection(step().verify(installation, first))) as FactoryProvisioningError).code).toBe("invitation_missing");
    });

    test("rotate replaces an expired invitation with a live one", async () => {
      await step(NOW, 1_000).ensure(installation, undefined);
      const later = NOW + 5_000;
      await step(later, 1_000).rotate(installation);
      const stored = await loadFactoryBootstrapInvitation(invitationPath(), "inst-1");
      const { token } = await outbox();
      expect(code(() => verifyFactoryBootstrapInvitation(stored, { token, email: "first.admin@example.com" }, later))).toBe("accepted");
    });

    test("verify detects a replaced outbox", async () => {
      const resources = await step().ensure(installation, undefined);
      const original = await outbox();
      for (const replaced of [{ ...original, token: "B".repeat(43) }, { ...original, invitationId: "invite-2" }, { ...original, hostname: "tenant-02.factory.example" }]) {
        await replaceFactoryPrivateFile(outboxPath(), JSON.stringify(replaced));
        const error = await rejection(step().verify(installation, resources));
        expect(error).toBeInstanceOf(FactoryProvisioningError);
        expect((error as FactoryProvisioningError).code).toBe("invitation_outbox_mismatch");
      }
    });

    test("verify reports a corrupt outbox and a missing outbox", async () => {
      const resources = await step().ensure(installation, undefined);
      await replaceFactoryPrivateFile(outboxPath(), "{not json");
      expect(((await rejection(step().verify(installation, resources))) as FactoryProvisioningError).code).toBe("provisioning_secret_corrupt");
      await step().teardown(installation);
      await replaceFactoryPrivateFile(invitationPath(), JSON.stringify(await invitationForResources(resources)));
      expect((await rejection(step().verify(installation, resources))).code).toBe("ENOENT");
    });

    test("verify refuses a missing invitation, a digest mismatch, and a foreign invitation ID", async () => {
      const driver = step();
      expect(((await rejection(driver.verify(installation, { tokenDigest: factoryInvitationTokenDigest(TOKEN) }))) as FactoryProvisioningError).code).toBe("invitation_missing");
      const resources = await driver.ensure(installation, undefined);
      expect(((await rejection(driver.verify(installation, { ...resources, tokenDigest: "sha256:x" }))) as FactoryProvisioningError).code).toBe("invitation_missing");
      expect(((await rejection(driver.verify({ ...installation, invitationId: "invite-2" }, resources))) as FactoryProvisioningError).code).toBe("invitation_missing");
      expect(((await rejection(driver.verify({ ...installation, installationId: "inst-2" }, resources))) as FactoryProvisioningError).message).toBe("The installation's invitation is missing or was replaced.");
    });

    test("teardown removes both files and is idempotent", async () => {
      const driver = step();
      const resources = await driver.ensure(installation, undefined);
      await driver.teardown(installation);
      expect(await readdir(installation.secretDirectory)).toEqual([]);
      expect(await readdir(installation.operatorDirectory)).toEqual([]);
      await driver.teardown(installation);
      expect(await readdir(installation.secretDirectory)).toEqual([]);
      expect(((await rejection(driver.verify(installation, resources))) as FactoryProvisioningError).code).toBe("invitation_missing");
      const reissued = await driver.ensure(installation, resources);
      expect(reissued.tokenDigest).not.toBe(resources.tokenDigest);
    });

    test("teardown on a never-provisioned installation creates private directories and succeeds", async () => {
      await step().teardown(installation);
      expect((await stat(installation.secretDirectory)).mode & 0o777).toBe(0o700);
      expect(await readdir(installation.operatorDirectory)).toEqual([]);
    });

    test("an invitation file readable by others is treated as absent and replaced by ensure", async () => {
      const driver = step();
      const resources = await driver.ensure(installation, undefined);
      await writeModeFile(invitationPath(), await readFile(invitationPath(), "utf8"), 0o644);
      expect(((await rejection(driver.verify(installation, resources))) as FactoryProvisioningError).code).toBe("invitation_missing");
      const reissued = await driver.ensure(installation, resources);
      expect(reissued.tokenDigest).not.toBe(resources.tokenDigest);
      expect((await stat(invitationPath())).mode & 0o777).toBe(0o600);
    });
  });
});

function invitationForResources(resources: Readonly<Record<string, string>>): FactoryBootstrapInvitation {
  return invitation({ invitationId: resources.invitationId!, tokenDigest: resources.tokenDigest!, expiresAtMs: Number(resources.expiresAtMs), administratorEmail: "first.admin@example.com" });
}
