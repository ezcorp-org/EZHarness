import { and, desc, eq, gt } from "drizzle-orm";
import { TRUSTED_LOCAL_OMITTED_CONTROLS, type TrustedLocalApproval } from "@ezcorp/extension-runner";
import { getDb } from "../connection";
import { extensionTrustedLocalApprovals } from "../schema";

/**
 * The store behind `TrustedLocalRunner.approvalFor()` — see the migration
 * (`src/db/migrations/add-extension-trusted-local-approvals.ts`) for why this
 * is its own table. Rows are written only from the lifecycle's two human
 * acknowledgement points and read only by the runner's `authorize()`.
 */
export type TrustedLocalPhase = TrustedLocalApproval["phase"];

/**
 * 180 days. The runner rejects an expired row at the next build or worker
 * start (`trusted_approval_required`), so an approval is never open-ended —
 * the v4 plan requires an expiry — but it outlives any reasonable release
 * life, so an active extension does not stop mid-quarter. Re-approval is one
 * click on the author page.
 */
export const TRUSTED_LOCAL_APPROVAL_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function toApproval(row: typeof extensionTrustedLocalApprovals.$inferSelect): TrustedLocalApproval {
  return { digest: row.digest, phase: row.phase, approvedBy: row.approvedBy, expiresAt: row.expiresAt.getTime(), omittedControls: JSON.parse(row.omittedControls) as string[] };
}

/**
 * Record (or refresh) a human's acknowledgement that this exact digest may
 * build or run without the seven omitted controls. Always stamps the FULL
 * `TRUSTED_LOCAL_OMITTED_CONTROLS` list: the runner refuses an approval that
 * names fewer, so there is no partial acknowledgement to offer.
 */
export async function recordTrustedLocalApproval(input: { installationId: string; phase: TrustedLocalPhase; digest: string; approvedBy: string; now?: number }): Promise<TrustedLocalApproval> {
  const expiresAt = new Date((input.now ?? Date.now()) + TRUSTED_LOCAL_APPROVAL_TTL_MS);
  const omittedControls = JSON.stringify([...TRUSTED_LOCAL_OMITTED_CONTROLS]);
  const values = { installationId: input.installationId, phase: input.phase, digest: input.digest, approvedBy: input.approvedBy, expiresAt, omittedControls };
  const t = extensionTrustedLocalApprovals;
  await getDb().insert(t).values(values).onConflictDoUpdate({ target: [t.installationId, t.phase, t.digest], set: { approvedBy: values.approvedBy, expiresAt, omittedControls, createdAt: new Date(input.now ?? Date.now()) } });
  return { digest: input.digest, phase: input.phase, approvedBy: input.approvedBy, expiresAt: expiresAt.getTime(), omittedControls: [...TRUSTED_LOCAL_OMITTED_CONTROLS] };
}

/**
 * Fifteen minutes. Candidate verification starts a worker from the freshly
 * built artifact — an `execute` in the runner's eyes — before any release
 * approval can exist, so the BUILD acknowledgement has to cover it: the human
 * acknowledged that this exact source is built, tested and verified without
 * a sandbox. The grant is derived (same approver as the build row) and short:
 * verification runs immediately inside `runBuild`, and nothing else may
 * start a worker for an unreleased artifact. Release execution needs its own
 * long-lived row, recorded only by "Approve exact release".
 */
export const TRUSTED_LOCAL_VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

/**
 * Grant verification of `artifactDigest` under the build acknowledgement that
 * produced it. Refuses (returns null, records nothing) when the installation
 * holds no live build approval for `sourceDigest` — the runner then refuses
 * verification too, which is the correct answer for a build nobody
 * acknowledged.
 */
export async function recordTrustedLocalVerificationApproval(input: { installationId: string; sourceDigest: string; artifactDigest: string; now?: number }): Promise<TrustedLocalApproval | null> {
  const now = input.now ?? Date.now();
  const t = extensionTrustedLocalApprovals;
  const build = (await getDb().select().from(t).where(and(eq(t.installationId, input.installationId), eq(t.phase, "build"), eq(t.digest, input.sourceDigest), gt(t.expiresAt, new Date(now)))).limit(1))[0];
  if (!build) return null;
  const expiresAt = new Date(now + TRUSTED_LOCAL_VERIFICATION_WINDOW_MS);
  const values = { installationId: input.installationId, phase: "execute" as const, digest: input.artifactDigest, approvedBy: build.approvedBy, expiresAt, omittedControls: build.omittedControls };
  await getDb().insert(t).values(values).onConflictDoUpdate({ target: [t.installationId, t.phase, t.digest], set: { approvedBy: values.approvedBy, expiresAt, omittedControls: values.omittedControls, createdAt: new Date(now) } });
  return toApproval({ ...values, createdAt: new Date(now) });
}

/** The live approval for this digest and phase from ANY installation, or null. Expired rows are invisible. */
export async function findTrustedLocalApproval(phase: TrustedLocalPhase, digest: string, now = Date.now()): Promise<TrustedLocalApproval | null> {
  const t = extensionTrustedLocalApprovals;
  const rows = await getDb().select().from(t).where(and(eq(t.phase, phase), eq(t.digest, digest), gt(t.expiresAt, new Date(now)))).orderBy(desc(t.expiresAt)).limit(1);
  return rows[0] ? toApproval(rows[0]) : null;
}

/**
 * Drop an installation's approvals — all of them (disable / uninstall), or
 * just the one execute-phase digest of a single revoked release. Other
 * installations' rows for the same digest are untouched by design.
 */
export async function revokeTrustedLocalApprovals(installationId: string, digest?: string): Promise<number> {
  const t = extensionTrustedLocalApprovals;
  const where = digest === undefined ? eq(t.installationId, installationId) : and(eq(t.installationId, installationId), eq(t.digest, digest));
  const deleted = await getDb().delete(t).where(where).returning({ digest: t.digest });
  return deleted.length;
}
