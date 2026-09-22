import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import type {
  FactoryAffectedRun, FactoryApiPage, FactoryListQuery, FactoryPackageImpact, FactoryPackageInstallBody, FactoryPackageResource, FactoryPackageTransition, FactoryRunStatus, RunnerReference,
} from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { FactoryConsoleError } from "./console-tokens";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { TRUST_TRANSITIONS, type FactoryPackagePreparations, type FactoryPackageTrusts, type FactoryRunnerPackageTrustRecord } from "./package-preparation";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";

const LIVE_RUNS = ["queued", "running", "waiting", "cancelling", "uncertain"] as const;
const IMPACT_CAP = 200;
const DEFAULT_LIMIT = 50;

type BindingRow = { reference_digest: string; reference_json: string; installation_id: string; release_id: string; bound_ms: string | number; revision: string | number | null; state: string | null };

/** The path form of a stored `sha256:` reference digest: its 64 lowercase hex characters. */
export function factoryPackageReferenceId(referenceDigest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(referenceDigest)) throw new FactoryConsoleError("factory_package_not_found");
  return referenceDigest.slice("sha256:".length);
}
function storedDigest(referenceId: string): string {
  if (!/^[0-9a-f]{64}$/.test(referenceId)) throw new FactoryConsoleError("factory_package_not_found");
  return `sha256:${referenceId}`;
}

function resource(row: BindingRow): FactoryPackageResource {
  return {
    referenceId: factoryPackageReferenceId(row.reference_digest), reference: JSON.parse(row.reference_json) as RunnerReference,
    revision: row.revision === null ? 0 : Number(row.revision), ...(row.state === null ? {} : { state: row.state as FactoryPackageResource["state"] }),
    installationId: row.installation_id, releaseId: row.release_id, boundAtMs: Number(row.bound_ms),
  };
}

/**
 * The administrator's view of a project's runner packages (C01 `admin` row, C09).
 *
 * It adds no authority of its own. Binding and every trust transition run
 * through W02's `FactoryPackagePreparations` and `FactoryPackageTrusts`, which
 * require a human session holding `factory.trust`, write the transactional
 * audit, and fence live attempts in the same commit. This class only finds the
 * pinned reference behind a path and previews which runs a transition reaches.
 */
export class FactoryPackageAdmin {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly preparations: Pick<FactoryPackagePreparations, "bind" | "tenantId">,
    private readonly trusts: Pick<FactoryPackageTrusts, "publish" | "quarantine" | "revoke" | "tenantId">,
  ) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId || preparations.tenantId !== tenantId || trusts.tenantId !== tenantId) throw new Error("factory_scope_mismatch");
  }

  async list(principal: FactoryPrincipal, projectId: string, query: FactoryListQuery = {}): Promise<FactoryApiPage<FactoryPackageResource>> {
    const input = JSON.parse(encodeFactoryPayload({ principal, projectId, query })) as { principal: FactoryPrincipal; projectId: string; query: FactoryListQuery };
    assertFactoryIdentity(input.projectId);
    const limit = input.query.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > IMPACT_CAP) throw new FactoryConsoleError("factory_page_invalid");
    const after = input.query.cursor === undefined ? null : storedDigest(input.query.cursor);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, input.principal, input.projectId, "read");
      const found = rows<BindingRow>(await transaction.execute(sql`${this.bindingSelect(input.projectId)}
        ${after === null ? sql`` : sql`AND b.reference_digest > ${after}`}
        ${input.query.search === undefined ? sql`` : sql`AND strpos(b.package_name, ${input.query.search}) > 0`}
        ORDER BY b.reference_digest LIMIT ${limit + 1}`));
      const items = found.slice(0, limit).map(resource);
      return found.length > limit ? { items, nextCursor: items.at(-1)!.referenceId } : { items };
    });
  }

  /** Binds an installed v4 release to the project. Trust is a separate, explicit transition. */
  async install(principal: FactoryPrincipal, projectId: string, body: FactoryPackageInstallBody, idempotencyKey: string): Promise<FactoryPackageResource> {
    const binding = await this.preparations.bind(principal, { projectId, reference: body.reference, installationId: body.installationId, releaseId: body.releaseId }, idempotencyKey);
    return this.read(principal, projectId, factoryPackageReferenceId(await this.referenceDigest(projectId, binding.reference)));
  }

  async transition(principal: FactoryPrincipal, projectId: string, referenceId: string, transition: FactoryPackageTransition, expectedRevision: number, idempotencyKey: string): Promise<FactoryPackageResource> {
    const current = await this.read(principal, projectId, referenceId);
    const input = { projectId, reference: current.reference, expectedRevision };
    const record: FactoryRunnerPackageTrustRecord = transition === "publish" ? await this.trusts.publish(principal, input, idempotencyKey)
      : transition === "quarantine" ? await this.trusts.quarantine(principal, input, idempotencyKey)
        : await this.trusts.revoke(principal, input, idempotencyKey);
    return { ...current, revision: record.revision, state: record.state };
  }

  async read(principal: FactoryPrincipal, projectId: string, referenceId: string): Promise<FactoryPackageResource> {
    const digest = storedDigest(referenceId);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, projectId, "read");
      const [row] = rows<BindingRow>(await transaction.execute(sql`${this.bindingSelect(projectId)} AND b.reference_digest=${digest}`));
      if (!row) throw new FactoryConsoleError("factory_package_not_found");
      return resource(row);
    });
  }

  /**
   * Which live runs a transition would reach, before an administrator commits
   * it. `allowed` applies the same state machine the transition enforces.
   */
  async impact(principal: FactoryPrincipal, projectId: string, referenceId: string, transition: FactoryPackageTransition): Promise<FactoryPackageImpact> {
    const current = await this.read(principal, projectId, referenceId);
    const rule = TRUST_TRANSITIONS[transition];
    const allowed = rule.from.includes(current.state ?? "none");
    // A version lock is canonical JSON, so the exact entry that pins this package appears verbatim.
    // Matching the digest alone is not enough: two packages in one lock can share placeholder bytes.
    const lockEntry = canonicalJson({ digest: current.reference.digest, name: current.reference.package, version: current.reference.version });
    const digestNeedle = JSON.stringify(current.reference.digest);
    const found = rows<{ run_id: string; factory_id: string; status: string; live: string | number }>(await this.database.execute(sql`SELECT l.run_id, l.factory_id, l.status,
        (SELECT COUNT(*) FROM factory_executions e WHERE e.tenant_id=l.tenant_id AND e.project_id=l.project_id AND e.run_id=l.run_id AND e.status IN ('admitted','running') AND strpos(e.request_json::text, ${digestNeedle}) > 0) AS live
      FROM factory_run_lifecycle l JOIN factory_versions v ON v.tenant_id=l.tenant_id AND v.project_id=l.project_id AND v.factory_id=l.factory_id AND v.version=l.factory_version
      WHERE l.tenant_id=${this.tenantId} AND l.project_id=${projectId} AND l.status IN (${sql.join(LIVE_RUNS.map(status => sql`${status}`), sql`, `)}) AND strpos(v.lock_json, ${lockEntry}) > 0
      ORDER BY l.run_id LIMIT ${IMPACT_CAP + 1}`));
    const runs: FactoryAffectedRun[] = found.slice(0, IMPACT_CAP).map(row => ({ runId: row.run_id, factoryId: row.factory_id, status: row.status as FactoryRunStatus, liveAttempts: Number(row.live) }));
    return {
      transition, currentRevision: current.revision, allowed,
      ...(allowed ? {} : { refusal: `The ${current.state ?? "untrusted"} package cannot take the ${transition} transition.` }),
      // Publishing blocks nothing; the preview still lists who will use the package.
      runs, truncated: found.length > IMPACT_CAP,
    };
  }

  private bindingSelect(projectId: string) {
    return sql`SELECT b.reference_digest, b.reference_json, b.installation_id, b.release_id, (EXTRACT(EPOCH FROM b.created_at) * 1000)::bigint AS bound_ms, c.revision, r.state
      FROM factory_runner_package_bindings b
      LEFT JOIN factory_runner_package_trust_current c ON c.tenant_id=b.tenant_id AND c.project_id=b.project_id AND c.reference_digest=b.reference_digest
      LEFT JOIN factory_runner_package_trust_revisions r ON r.tenant_id=c.tenant_id AND r.project_id=c.project_id AND r.reference_digest=c.reference_digest AND r.revision=c.revision
      WHERE b.tenant_id=${this.tenantId} AND b.project_id=${projectId}`;
  }

  private async referenceDigest(projectId: string, reference: RunnerReference): Promise<string> {
    const [row] = rows<{ reference_digest: string }>(await this.database.execute(sql`SELECT reference_digest FROM factory_runner_package_bindings
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND package_name=${reference.package} AND package_version=${reference.version} AND package_digest=${reference.digest} AND export_name=${reference.export}`));
    if (!row) throw new FactoryConsoleError("factory_package_not_found");
    return row.reference_digest;
  }
}
