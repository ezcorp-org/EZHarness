/**
 * C12 step 7: the first-administrator invitation, and the one file format the
 * provisioner and the installation both read.
 *
 * The invitation is a bearer token delivered out of band to one named person.
 * The installation receives only its DIGEST, its identifier, the invited
 * email, and its expiry; the token itself goes to the operator's outbox and
 * nowhere else. First-run setup refuses to create an administrator without it,
 * which closes the window a freshly deployed installation otherwise has, where
 * the first stranger to reach `/api/auth/setup` becomes its administrator.
 *
 * Issuing the invitation does NOT establish consent. C01 makes the first human
 * login the consent authority, and consent is a separate, explicit act inside
 * the installation (`bootstrap.ts`), written with its audit entry in one
 * transaction.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { factoryDeliveryDirectory, type FactoryInstallationContext, type FactoryProvisioningDriver, type FactoryStepResources } from "./installation";
import { factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateJson, readFactoryPrivatePath, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_BOOTSTRAP_INVITATION_SCHEMA = "factory.bootstrap-invitation.v1";
export const FACTORY_BOOTSTRAP_INVITATION_FILE = "bootstrap-invitation.json";
export const FACTORY_INVITATION_OUTBOX_FILE = "first-admin-invitation.json";
export const FACTORY_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** What the installation holds. No token. */
export interface FactoryBootstrapInvitation {
  readonly schemaVersion: typeof FACTORY_BOOTSTRAP_INVITATION_SCHEMA;
  readonly installationId: string;
  readonly tenantId: string;
  readonly invitationId: string;
  readonly administratorEmail: string;
  readonly tokenDigest: string;
  readonly expiresAtMs: number;
}

/** What the operator delivers to the invited person. */
export interface FactoryInvitationOutbox {
  readonly schemaVersion: "factory.invitation-outbox.v1";
  readonly installationId: string;
  readonly invitationId: string;
  readonly hostname: string;
  readonly administratorEmail: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

export class FactoryBootstrapInvitationError extends Error {
  constructor(readonly code: "bootstrap_invitation_required" | "bootstrap_invitation_invalid" | "bootstrap_invitation_expired" | "bootstrap_invitation_email_mismatch" | "bootstrap_invitation_unavailable") {
    super(code);
    this.name = "FactoryBootstrapInvitationError";
  }
}

export function factoryInvitationTokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

export function parseFactoryBootstrapInvitation(value: unknown, installationId: string): FactoryBootstrapInvitation {
  const record = value as Partial<FactoryBootstrapInvitation> | null;
  const keys = record && typeof record === "object" ? Object.keys(record).sort().join(",") : "";
  if (keys !== "administratorEmail,expiresAtMs,installationId,invitationId,schemaVersion,tenantId,tokenDigest" || record!.schemaVersion !== FACTORY_BOOTSTRAP_INVITATION_SCHEMA
    || record!.installationId !== installationId || typeof record!.tenantId !== "string" || !record!.tenantId || typeof record!.invitationId !== "string" || !record!.invitationId
    || typeof record!.administratorEmail !== "string" || !record!.administratorEmail.includes("@")
    || typeof record!.tokenDigest !== "string" || !DIGEST.test(record!.tokenDigest)
    || !Number.isSafeInteger(record!.expiresAtMs) || record!.expiresAtMs! < 0) {
    throw new FactoryBootstrapInvitationError("bootstrap_invitation_unavailable");
  }
  return Object.freeze({ ...record } as FactoryBootstrapInvitation);
}

/**
 * Check a presented token against the installation's invitation.
 *
 * Constant-time on the digest. The email comparison is case-insensitive
 * because the account is created lower-cased; every refusal names its reason
 * to the caller's code but the route answers all of them with one status.
 */
export function verifyFactoryBootstrapInvitation(invitation: FactoryBootstrapInvitation, presented: { readonly token: unknown; readonly email: string }, nowMs: number): void {
  if (typeof presented.token !== "string" || presented.token.length === 0) throw new FactoryBootstrapInvitationError("bootstrap_invitation_required");
  if (!TOKEN.test(presented.token)) throw new FactoryBootstrapInvitationError("bootstrap_invitation_invalid");
  const expected = Buffer.from(invitation.tokenDigest);
  const actual = Buffer.from(factoryInvitationTokenDigest(presented.token));
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) throw new FactoryBootstrapInvitationError("bootstrap_invitation_invalid");
  if (nowMs >= invitation.expiresAtMs) throw new FactoryBootstrapInvitationError("bootstrap_invitation_expired");
  if (presented.email.trim().toLowerCase() !== invitation.administratorEmail.toLowerCase()) throw new FactoryBootstrapInvitationError("bootstrap_invitation_email_mismatch");
}

/** Read the installation's invitation through the private reader. Absent means "not a provisioned installation". */
export async function loadFactoryBootstrapInvitation(path: string, installationId: string): Promise<FactoryBootstrapInvitation> {
  let bytes: Uint8Array;
  try { bytes = await readFactoryPrivatePath(path, 16 * 1024); }
  catch { throw new FactoryBootstrapInvitationError("bootstrap_invitation_unavailable"); }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new FactoryBootstrapInvitationError("bootstrap_invitation_unavailable"); }
  return parseFactoryBootstrapInvitation(parsed, installationId);
}

export interface FactoryInvitationStepOptions {
  readonly now?: () => number;
  readonly lifetimeMs?: number;
}

export class FactoryInvitationStep implements FactoryProvisioningDriver {
  readonly step = "invitation" as const;
  private readonly now: () => number;
  private readonly lifetimeMs: number;
  constructor(options: FactoryInvitationStepOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lifetimeMs = options.lifetimeMs ?? FACTORY_INVITATION_LIFETIME_MS;
  }

  /**
   * Three copies, each with one reader: the installation's source, the copy in
   * the harness's own delivery (read per request, so a re-issued invitation
   * takes effect without a restart), and the operator outbox holding the token.
   */
  paths(installation: FactoryInstallationContext): { readonly invitation: string; readonly delivered: string; readonly outbox: string } {
    return {
      invitation: factoryPrivatePath(installation.secretDirectory, FACTORY_BOOTSTRAP_INVITATION_FILE),
      delivered: factoryPrivatePath(factoryDeliveryDirectory(installation, "harness"), FACTORY_BOOTSTRAP_INVITATION_FILE),
      outbox: factoryPrivatePath(installation.operatorDirectory, FACTORY_INVITATION_OUTBOX_FILE),
    };
  }

  /** Issue once. A rerun keeps a live invitation; an expired one is replaced by `rotate`. */
  async ensure(installation: FactoryInstallationContext, recorded: FactoryStepResources | undefined): Promise<FactoryStepResources> {
    const existing = await this.current(installation);
    if (existing && recorded?.tokenDigest === existing.tokenDigest) {
      await this.deliver(installation);
      return this.resources(installation, existing);
    }
    return this.issue(installation);
  }

  /** Copy the installation's invitation into the harness's delivery, atomically. */
  private async deliver(installation: FactoryInstallationContext): Promise<void> {
    const paths = this.paths(installation);
    await replaceFactoryPrivateFile(paths.delivered, await readFactoryPrivatePath(paths.invitation, 16 * 1024));
  }

  async verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    const current = await this.current(installation);
    if (!current || current.tokenDigest !== resources.tokenDigest || current.invitationId !== installation.invitationId) throw new FactoryProvisioningError("invitation_missing", "The installation's invitation is missing or was replaced.");
    let delivered: FactoryBootstrapInvitation | undefined;
    try { delivered = await loadFactoryBootstrapInvitation(this.paths(installation).delivered, installation.installationId); } catch { delivered = undefined; }
    if (delivered?.tokenDigest !== current.tokenDigest) throw new FactoryProvisioningError("invitation_undelivered", "The harness does not hold the installation's current invitation.");
    const directory = await openFactoryPrivateDirectory(installation.operatorDirectory);
    try {
      const outbox = await readFactoryPrivateJson<FactoryInvitationOutbox>(directory, FACTORY_INVITATION_OUTBOX_FILE);
      if (factoryInvitationTokenDigest(outbox.token) !== current.tokenDigest || outbox.invitationId !== current.invitationId || outbox.hostname !== installation.hostname) throw new FactoryProvisioningError("invitation_outbox_mismatch", "The operator outbox does not hold this invitation.");
    } finally { await directory.close(); }
  }

  async teardown(installation: FactoryInstallationContext): Promise<void> {
    for (const [root, name] of [[installation.secretDirectory, FACTORY_BOOTSTRAP_INVITATION_FILE], [factoryDeliveryDirectory(installation, "harness"), FACTORY_BOOTSTRAP_INVITATION_FILE], [installation.operatorDirectory, FACTORY_INVITATION_OUTBOX_FILE]] as const) {
      const directory = await openFactoryPrivateDirectory(root);
      try { await removeFactoryPrivateFile(directory, name); } finally { await directory.close(); }
    }
  }

  /** Re-issue: a new token and expiry under the same invitation identity. The old token stops matching at once. */
  async rotate(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    return this.issue(installation);
  }

  private async issue(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + this.lifetimeMs;
    const invitation: FactoryBootstrapInvitation = { schemaVersion: FACTORY_BOOTSTRAP_INVITATION_SCHEMA, installationId: installation.installationId, tenantId: installation.tenantId, invitationId: installation.invitationId, administratorEmail: installation.administratorEmail.toLowerCase(), tokenDigest: factoryInvitationTokenDigest(token), expiresAtMs };
    const outbox: FactoryInvitationOutbox = { schemaVersion: "factory.invitation-outbox.v1", installationId: installation.installationId, invitationId: installation.invitationId, hostname: installation.hostname, administratorEmail: invitation.administratorEmail, token, expiresAtMs };
    const paths = this.paths(installation);
    // Outbox first: an installation never holds a digest whose token nobody can deliver.
    await replaceFactoryPrivateFile(paths.outbox, `${JSON.stringify(outbox)}\n`);
    await replaceFactoryPrivateFile(paths.invitation, `${JSON.stringify(invitation)}\n`);
    await this.deliver(installation);
    return this.resources(installation, invitation);
  }

  private async current(installation: FactoryInstallationContext): Promise<FactoryBootstrapInvitation | undefined> {
    try { return await loadFactoryBootstrapInvitation(this.paths(installation).invitation, installation.installationId); }
    catch { return undefined; }
  }

  private resources(installation: FactoryInstallationContext, invitation: FactoryBootstrapInvitation): FactoryStepResources {
    const paths = this.paths(installation);
    return Object.freeze({ invitationId: invitation.invitationId, invitationPath: paths.invitation, outboxPath: paths.outbox, tokenDigest: invitation.tokenDigest, expiresAtMs: String(invitation.expiresAtMs) });
  }
}
