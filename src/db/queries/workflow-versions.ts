/**
 * Immutable version snapshots of a workflow definition.
 *
 * ## Why this exists, and what it demotes
 *
 * Phase 2 shipped `workflow_runs.definition_hash` as the interim drift
 * guard for suspend/resume. This module makes `definition_version_id`
 * **authoritative** for "which definition did this run execute", and
 * demotes the hash to a function of a version row's `steps`
 * ({@link versionStepsHash}) — the same input `workflowDefinitionHash`
 * already took, so the redefinition is a no-op rather than a behaviour
 * change that would fail-close every parked run on upgrade.
 *
 * Two mechanisms answering one question is how they drift, so the
 * precedence is stated once, here — as the CONTRACT the resume path owes,
 * not as a description of what runs today:
 *
 *   1. `definition_version_id` non-NULL ⇒ it decides. Full stop.
 *   2. `definition_version_id` NULL ⇒ fall back to `definition_hash`.
 *      NULL means the run predates versioning, or it ran a YAML /
 *      extension workflow that has no `workflow_definitions` row to
 *      version in the first place.
 *
 * **Nothing enforces that ordering yet.** No caller reads
 * `definition_hash` at all except C4's resume, which compares it
 * UNCONDITIONALLY and never looks at the version id; this module's
 * version id is read only by the retention sweep and
 * {@link getRunVersionLabel}. So the hash is the drift guard that
 * actually fires, and rule 1 is what C4's resume has to adopt. Written
 * down because the alternative is the next reader deriving a second
 * answer — and a system carrying two answers eventually disagrees with
 * itself, silently.
 *
 * ## Versions are immutable
 *
 * Nothing in this module ever UPDATEs a version row. A rename does not
 * mint a version and does not rewrite history either — `name` on a
 * version is the name *at that version*, so a rename becomes visible at
 * the next minted version and the audit trail stays truthful.
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "../connection";
import { workflowDefinitions, workflowDefinitionVersions, workflowRuns } from "../schema";
import type { WorkflowDefinitionVersionRow } from "../schema";
import {
  stableStringify,
  workflowDefinitionHash,
} from "../../runtime/workflow-definition-hash";
import type { InputSchema, WorkflowModelBinding, WorkflowStep } from "../../types";

export type WorkflowVersion = WorkflowDefinitionVersionRow;

/**
 * A drizzle handle. `migrate()` passes its own executor (getDb() is not
 * guaranteed wired during the migrate pass); everything else defaults to
 * `getDb()`. Same convention as `backfillMcpManifestSecrets`.
 */
// `any` because drizzle's PGlite and bun-sql handles share no public
// type — the same reason `backfillMcpManifestSecrets` types its executor
// this way.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbExecutor = any;

/**
 * The slice of a definition that decides WHAT RUNS. A change here mints a
 * version; a change to anything else does not.
 *
 * `description` and `name` are excluded deliberately, and this is the
 * load-bearing rule of the whole module: C3's consent hash pins a
 * version, so minting one on a typo fix would suspend every delegated job
 * for re-consent over a prose edit — which trains users to click through,
 * the exact failure the consent design exists to prevent.
 */
export interface VersionMaterial {
  steps: WorkflowStep[];
  inputSchema?: InputSchema | Record<string, unknown> | null;
  defaultModel?: WorkflowModelBinding | null;
}

/**
 * The canonical hash of a version's executable content.
 *
 * Deliberately delegates to the SAME `workflowDefinitionHash` the runtime
 * writes onto `workflow_runs.definition_hash`, over the same material
 * (`steps` + `defaultModel`). That identity is what makes the hash "a
 * function of the version row" rather than a second, independently-drifting
 * fingerprint — and it is why `inputSchema` is compared separately below
 * instead of being folded in here. Widening the hash's material would
 * change every existing run's fingerprint and fail-close resumes that are
 * currently fine.
 */
export function versionStepsHash(material: VersionMaterial): string {
  return workflowDefinitionHash({
    name: "",
    description: "",
    steps: material.steps ?? [],
    ...(material.defaultModel != null ? { defaultModel: material.defaultModel } : {}),
  });
}

/**
 * Stable identity of a version's executable content — the hash plus the
 * `input_schema` the hash deliberately omits. Two definitions with the
 * same key run identically, so an edit that leaves the key unchanged
 * mints no version.
 *
 * Key-order-insensitive via the shared {@link stableStringify}: a jsonb
 * round-trip does not preserve key insertion order, and comparing raw
 * `JSON.stringify` output would mint a spurious version on every save.
 */
export function versionMaterialKey(material: VersionMaterial): string {
  return `${versionStepsHash(material)}:${stableStringify(material.inputSchema ?? null)}`;
}

/** True when `next` would run differently from the recorded `current`. */
export function versionMaterialChanged(
  current: VersionMaterial,
  next: VersionMaterial,
): boolean {
  return versionMaterialKey(current) !== versionMaterialKey(next);
}

/** Latest (highest `version`) snapshot for a definition, if any. */
export async function getLatestWorkflowVersion(
  definitionId: string,
  executor: DbExecutor = getDb(),
): Promise<WorkflowVersion | undefined> {
  const rows = (await executor
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.workflowDefinitionId, definitionId))
    .orderBy(desc(workflowDefinitionVersions.version))
    .limit(1)) as WorkflowVersion[];
  return rows[0];
}

/** Full version history for a definition, oldest first. */
export async function listWorkflowVersions(
  definitionId: string,
  executor: DbExecutor = getDb(),
): Promise<WorkflowVersion[]> {
  return (await executor
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.workflowDefinitionId, definitionId))
    .orderBy(asc(workflowDefinitionVersions.version))) as WorkflowVersion[];
}

/** One version by id. */
export async function getWorkflowVersion(
  id: string,
  executor: DbExecutor = getDb(),
): Promise<WorkflowVersion | undefined> {
  const rows = (await executor
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.id, id))
    .limit(1)) as WorkflowVersion[];
  return rows[0];
}

/** The definition row shape this module needs — a structural subset of
 *  `DbWorkflow`, so both the CRUD path and the backfill can pass one. */
export interface VersionableDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  defaultModel: WorkflowModelBinding | null;
  steps: WorkflowStep[];
}

/**
 * Return the version representing this definition's CURRENT executable
 * content, minting a new one only if that content actually changed.
 *
 * Idempotent by construction: calling it twice for an unedited definition
 * returns the same row both times, `minted: false`. That is what lets the
 * PUT route call it unconditionally without a description-only edit
 * inflating the history.
 */
export async function ensureWorkflowVersion(
  definition: VersionableDefinition,
  createdByUserId: string | null,
  executor: DbExecutor = getDb(),
): Promise<{ version: WorkflowVersion; minted: boolean }> {
  const material: VersionMaterial = {
    steps: definition.steps,
    inputSchema: definition.inputSchema,
    defaultModel: definition.defaultModel,
  };
  const latest = await getLatestWorkflowVersion(definition.id, executor);

  if (latest !== undefined) {
    const recorded: VersionMaterial = {
      steps: latest.steps,
      inputSchema: latest.inputSchema ?? null,
      defaultModel: latest.defaultModel ?? null,
    };
    if (!versionMaterialChanged(recorded, material)) {
      return { version: latest, minted: false };
    }
  }

  const row = {
    id: crypto.randomUUID(),
    workflowDefinitionId: definition.id,
    version: (latest?.version ?? 0) + 1,
    // The name/description AT THIS VERSION. A later rename does not come
    // back and rewrite this — history reads as it happened.
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    defaultModel: definition.defaultModel,
    steps: definition.steps,
    stepsHash: versionStepsHash(material),
    createdByUserId,
    createdAt: new Date(),
  };
  await executor.insert(workflowDefinitionVersions).values(row);
  return { version: row as WorkflowVersion, minted: true };
}

/**
 * Seed version 1 for every definition that has none.
 *
 * The migration's ONE backfill, and guarded so a re-run is a zero-row
 * no-op: it selects only definitions with no version at all, so a second
 * boot finds nothing and writes nothing. It never reattributes anything —
 * `created_by_user_id` is NULL, because we do not know who authored a
 * pre-versioning definition and inventing an author is a lie in an audit
 * surface.
 *
 * Runs through the drizzle query builder rather than raw SQL on purpose:
 * `steps` / `input_schema` / `default_model` are jsonb, and raw-SQL jsonb
 * binding is DRIVER-SPECIFIC here (PGlite needs `::jsonb` text, bun-sql
 * needs the plain object — see `serializeJsonbFields` in
 * `queries/extensions.ts`). The builder gets it right for both.
 */
export async function backfillWorkflowDefinitionVersions(
  executor: DbExecutor = getDb(),
): Promise<number> {
  const definitions = (await executor
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      description: workflowDefinitions.description,
      inputSchema: workflowDefinitions.inputSchema,
      defaultModel: workflowDefinitions.defaultModel,
      steps: workflowDefinitions.steps,
    })
    .from(workflowDefinitions)) as VersionableDefinition[];
  if (definitions.length === 0) return 0;

  const versioned = (await executor
    .selectDistinct({ id: workflowDefinitionVersions.workflowDefinitionId })
    .from(workflowDefinitionVersions)) as Array<{ id: string }>;
  const already = new Set(versioned.map((r) => r.id));

  let seeded = 0;
  for (const definition of definitions) {
    if (already.has(definition.id)) continue;
    await ensureWorkflowVersion(definition, null, executor);
    seeded += 1;
  }
  return seeded;
}

/**
 * Default retention: keep the most recent N unreferenced versions per
 * definition. Versions are a `steps` blob and they are the audit trail
 * for what actually ran, so the bound is generous by design.
 */
export const DEFAULT_UNREFERENCED_VERSIONS_KEPT = 50;

export interface VersionSweepOptions {
  /** How many unreferenced versions to keep per definition. */
  keepUnreferencedPerDefinition?: number;
  /**
   * Version ids that must never be reaped, whatever their age.
   *
   * **This is the C3 extension point, and it is an argument rather than a
   * caught FK error on purpose.** C3 (phase 7) FKs
   * `workflow_delegations.definition_version_id` with ON DELETE RESTRICT:
   * a consent hash pins a snapshot, so reaping it would leave the consent
   * referencing something that no longer exists. Catching the resulting
   * violation would make the error the control — the sweep would be
   * *trying* to delete pinned rows and being stopped by the database.
   * Instead the sweep EXCLUDES them, and C3 supplies its non-revoked
   * delegation ids here. Nothing about that requires editing this
   * function.
   *
   * **REQUIRED, deliberately — do not make this optional again.** The one
   * production caller is a daily sub-tick inside a `try/catch` that logs
   * `warn` and carries on (`host-maintenance-daemon.ts`). So the day C3
   * lands and this is not supplied, the RESTRICT violation degrades to a
   * log line and the sweep stops reaping — permanently, silently, and from
   * a call site no test can observe. A required field turns that into a
   * compile error at every call site, including ones not written yet.
   * Pass an explicit empty iterable to state "nothing is pinned".
   */
  pinnedVersionIds: Iterable<string>;
  executor?: DbExecutor;
}

export interface VersionSweepResult {
  scanned: number;
  deleted: number;
  /** Ids excluded because a run or a caller-supplied pin references them. */
  retained: number;
}

/**
 * Reap unreferenced version snapshots.
 *
 * A version is EXCLUDED from the delete set — never merely protected by
 * the database — when any of these hold:
 *   - a surviving `workflow_runs` row points at it;
 *   - a caller-supplied pin names it (see
 *     {@link VersionSweepOptions.pinnedVersionIds});
 *   - it is among the most recent `keepUnreferencedPerDefinition` for its
 *     definition.
 *
 * The newest version of a definition is always among the kept ones, so
 * this can never orphan a live definition, even with `keep` set to 1.
 *
 * `options` has no default: `pinnedVersionIds` is required, so every
 * caller has to say what it is protecting — see the field's own comment
 * for why a log line is not an acceptable substitute for a compile error.
 */
export async function sweepWorkflowDefinitionVersions(
  options: VersionSweepOptions,
): Promise<VersionSweepResult> {
  const executor: DbExecutor = options.executor ?? getDb();
  const keep = Math.max(
    1,
    options.keepUnreferencedPerDefinition ?? DEFAULT_UNREFERENCED_VERSIONS_KEPT,
  );

  const all = (await executor
    .select({
      id: workflowDefinitionVersions.id,
      workflowDefinitionId: workflowDefinitionVersions.workflowDefinitionId,
      version: workflowDefinitionVersions.version,
    })
    .from(workflowDefinitionVersions)
    .orderBy(desc(workflowDefinitionVersions.version))) as Array<{
    id: string;
    workflowDefinitionId: string;
    version: number;
  }>;
  if (all.length === 0) return { scanned: 0, deleted: 0, retained: 0 };

  const pinned = new Set<string>(options.pinnedVersionIds);
  const referenced = (await executor
    .selectDistinct({ id: workflowRuns.definitionVersionId })
    .from(workflowRuns)
    .where(isNotNull(workflowRuns.definitionVersionId))) as Array<{ id: string }>;
  for (const row of referenced) pinned.add(row.id);

  // `all` is version-descending, so the first `keep` survivors seen for a
  // definition are its newest.
  const keptPerDefinition = new Map<string, number>();
  const doomed: string[] = [];
  for (const row of all) {
    if (pinned.has(row.id)) continue;
    const kept = keptPerDefinition.get(row.workflowDefinitionId) ?? 0;
    if (kept < keep) {
      keptPerDefinition.set(row.workflowDefinitionId, kept + 1);
      continue;
    }
    doomed.push(row.id);
  }

  if (doomed.length > 0) {
    await executor
      .delete(workflowDefinitionVersions)
      .where(inArray(workflowDefinitionVersions.id, doomed));
  }
  return {
    scanned: all.length,
    deleted: doomed.length,
    retained: all.length - doomed.length,
  };
}

/**
 * Resolve the version a run executed, for the trace.
 *
 * Returns `null` when the run carries no version id — a pre-C6 run, or a
 * YAML/extension workflow that has no definition row. The trace renders
 * that as "version unknown (pre-versioning)" rather than guessing, which
 * would be a lie in an audit surface.
 */
export async function getRunVersionLabel(
  workflowRunId: string,
  executor: DbExecutor = getDb(),
): Promise<{ version: number; current: number; name: string } | null> {
  const rows = (await executor
    .select({
      version: workflowDefinitionVersions.version,
      name: workflowDefinitionVersions.name,
      definitionId: workflowDefinitionVersions.workflowDefinitionId,
    })
    .from(workflowRuns)
    .innerJoin(
      workflowDefinitionVersions,
      eq(workflowRuns.definitionVersionId, workflowDefinitionVersions.id),
    )
    .where(and(eq(workflowRuns.id, workflowRunId), isNotNull(workflowRuns.definitionVersionId)))
    .limit(1)) as Array<{ version: number; name: string; definitionId: string }>;
  const row = rows[0];
  if (!row) return null;
  const latest = await getLatestWorkflowVersion(row.definitionId, executor);
  return { version: row.version, current: latest?.version ?? row.version, name: row.name };
}
