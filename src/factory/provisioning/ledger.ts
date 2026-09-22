/**
 * The control plane's provisioning ledger and tenant directory.
 *
 * This database belongs to the operator-only control plane (C12). It holds the
 * tenant directory — tenant ID, hostname, installation identity, contact, plan
 * limits, membership references — plus, per installation, one row for each of
 * the seven steps and an append-only event history. It holds no product fact,
 * no artifact, and no credential: every resource column is a REFERENCE (a path,
 * a name, an object identifier, a digest), and the schema test asserts no
 * column could hold more.
 *
 * Step rows are written OUTSIDE the provisioning transaction, on the ledger's
 * own connection, so a failure record survives the fault that caused it. The
 * provisioning transaction exists only to hold the per-tenant advisory lock.
 */
import { SQL } from "bun";
import { FACTORY_INSTALLATION_PHASES, FACTORY_PROVISIONING_STEPS, FACTORY_STEP_STATES, FactoryProvisioningError, factoryPhaseTransitionAllowed, isFactoryInstallationPhase, isFactoryStepState, type FactoryInstallationPhase, type FactoryProvisioningStepName, type FactoryStepFailure, type FactoryStepState } from "./steps";
import type { FactoryStepResources } from "./installation";

export interface FactoryInstallationRecord {
  readonly tenantId: string;
  readonly fleetId: string;
  readonly installationId: string;
  readonly hostname: string;
  readonly administratorEmail: string;
  readonly invitationId: string;
  readonly productDatabase: string;
  readonly productRole: string;
  readonly temporalNamespace: string;
  readonly secretDirectory: string;
  readonly operatorDirectory: string;
  readonly phase: FactoryInstallationPhase;
  readonly planLimits: Readonly<Record<string, number>>;
  readonly membershipRefs: readonly string[];
}

export interface FactoryStepRecord {
  readonly step: FactoryProvisioningStepName;
  readonly ordinal: number;
  readonly owner: string;
  readonly state: FactoryStepState;
  readonly attempts: number;
  readonly resources: FactoryStepResources;
  readonly failure: FactoryStepFailure | null;
}

export interface FactoryProvisioningEvent {
  readonly tenantId: string;
  readonly step: FactoryProvisioningStepName | null;
  readonly event: string;
  readonly detail: Readonly<Record<string, string>>;
}

const SCHEMA_LOCK = "factory-provisioner-schema-v2";
const REFERENCE_VALUE_LIMIT = 4_096;

type Row = Record<string, unknown>;

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new FactoryProvisioningError("provisioning_ledger_corrupt", `Installation record has no ${field}.`);
  return value;
}

function json<Value>(value: unknown, fallback: Value): Value {
  if (value === null || value === undefined) return fallback;
  return (typeof value === "string" ? JSON.parse(value) : value) as Value;
}

/**
 * A resource map is references only: bounded strings, no newlines.
 *
 * A credential is either a long high-entropy string or a PEM block; the second
 * always contains a newline and is refused outright, and every value is bounded.
 * This is a backstop, not the protection: the drivers never pass a value here.
 */
export function assertFactoryStepResources(resources: FactoryStepResources): FactoryStepResources {
  for (const [key, value] of Object.entries(resources)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || typeof value !== "string" || value.length > REFERENCE_VALUE_LIMIT || /[\r\n]/.test(value) || /-----BEGIN /.test(value)) {
      throw new FactoryProvisioningError("provisioning_resource_not_reference", `Step resource ${key} is not a reference.`);
    }
  }
  return Object.freeze({ ...resources });
}

export class FactoryProvisioningLedger {
  constructor(readonly sql: SQL) {}

  async setup(): Promise<void> {
    await this.sql.begin(async (control) => {
      await control.unsafe(`SELECT pg_advisory_xact_lock(hashtext('${SCHEMA_LOCK}'))`);
      // v1 columns, unchanged so an existing ledger keeps its rows.
      await control.unsafe("CREATE TABLE IF NOT EXISTS factory_installations (tenant_id text PRIMARY KEY, installation_id text NOT NULL UNIQUE, hostname text NOT NULL UNIQUE, administrator_email text NOT NULL, product_database text NOT NULL UNIQUE, product_role text NOT NULL UNIQUE, temporal_namespace text NOT NULL UNIQUE, secret_bundle_path text NOT NULL, state text NOT NULL CHECK (state IN ('partial','ready')), current_step text NOT NULL, invitation_id text NOT NULL, role_oid oid, database_oid oid, role_plan text, database_plan text)");
      for (const column of ["role_oid oid", "database_oid oid", "role_plan text", "database_plan text"]) await control.unsafe(`ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS ${column}`);
      // v2: the directory and the four-phase model.
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS fleet_id text");
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS operator_directory text");
      await control.unsafe(`ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'recorded' CHECK (phase IN (${FACTORY_INSTALLATION_PHASES.map((phase) => `'${phase}'`).join(",")}))`);
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS plan_limits jsonb NOT NULL DEFAULT '{}'::jsonb");
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS membership_refs jsonb NOT NULL DEFAULT '[]'::jsonb");
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS phase_changed_at timestamptz NOT NULL DEFAULT now()");
      await control.unsafe(`CREATE TABLE IF NOT EXISTS factory_provisioning_steps (
        tenant_id text NOT NULL REFERENCES factory_installations(tenant_id),
        step text NOT NULL CHECK (step IN (${FACTORY_PROVISIONING_STEPS.map((spec) => `'${spec.step}'`).join(",")})),
        ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND ${FACTORY_PROVISIONING_STEPS.length}),
        owner text NOT NULL,
        state text NOT NULL CHECK (state IN (${FACTORY_STEP_STATES.map((state) => `'${state}'`).join(",")})),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        resources jsonb NOT NULL DEFAULT '{}'::jsonb,
        failure_code text,
        failure_message text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        PRIMARY KEY (tenant_id, step),
        UNIQUE (tenant_id, ordinal),
        CHECK ((state = 'failed') = (failure_code IS NOT NULL))
      )`);
      await control.unsafe("CREATE TABLE IF NOT EXISTS factory_provisioning_events (event_id bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES factory_installations(tenant_id), step text, event text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, recorded_at timestamptz NOT NULL DEFAULT now())");
      await control.unsafe("CREATE INDEX IF NOT EXISTS factory_provisioning_events_tenant ON factory_provisioning_events (tenant_id, event_id)");
    });
  }

  /** Record the durable intent. The first caller's identities win; a rerun keeps them. */
  async record(input: Omit<FactoryInstallationRecord, "phase" | "planLimits" | "membershipRefs"> & { readonly planLimits?: Readonly<Record<string, number>>; readonly rolePlan: string; readonly databasePlan: string }): Promise<void> {
    await this.sql`INSERT INTO factory_installations(tenant_id, installation_id, hostname, administrator_email, product_database, product_role, temporal_namespace, secret_bundle_path, state, current_step, invitation_id, role_plan, database_plan, fleet_id, operator_directory, phase, plan_limits)
      VALUES (${input.tenantId}, ${input.installationId}, ${input.hostname}, ${input.administratorEmail}, ${input.productDatabase}, ${input.productRole}, ${input.temporalNamespace}, ${input.secretDirectory}, 'partial', 'recorded', ${input.invitationId}, ${input.rolePlan}, ${input.databasePlan}, ${input.fleetId}, ${input.operatorDirectory}, 'recorded', ${JSON.stringify(input.planLimits ?? {})}::jsonb)
      ON CONFLICT (tenant_id) DO NOTHING`;
    for (const spec of FACTORY_PROVISIONING_STEPS) {
      await this.sql`INSERT INTO factory_provisioning_steps(tenant_id, step, ordinal, owner, state) VALUES (${input.tenantId}, ${spec.step}, ${spec.ordinal}, ${spec.owner}, 'pending') ON CONFLICT (tenant_id, step) DO NOTHING`;
    }
  }

  /** Hold the per-tenant lock for the duration of `work`. */
  async locked<Result>(tenantId: string, work: () => Promise<Result>): Promise<Result> {
    type Outcome = { value: Result } | { error: unknown };
    const outcome = await this.sql.begin<Outcome>(async (control) => {
      await control`SELECT pg_advisory_xact_lock(hashtextextended(${`factory-provisioner-v1:${tenantId}`}::text, 0))`;
      try { return { value: await work() }; } catch (error) { return { error }; }
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async installation(tenantId: string): Promise<(FactoryInstallationRecord & { readonly raw: Row }) | undefined> {
    const row = (await this.sql`SELECT tenant_id, fleet_id, installation_id, hostname, administrator_email, invitation_id, product_database, product_role, temporal_namespace, secret_bundle_path, operator_directory, phase, plan_limits, membership_refs, role_oid::text, database_oid::text, role_plan, database_plan, current_step FROM factory_installations WHERE tenant_id = ${tenantId}`)[0] as Row | undefined;
    if (!row) return undefined;
    const phase = row.phase;
    if (!isFactoryInstallationPhase(phase)) throw new FactoryProvisioningError("provisioning_ledger_corrupt", "Installation phase is corrupt.");
    return Object.freeze({
      tenantId: text(row, "tenant_id"), fleetId: text(row, "fleet_id"), installationId: text(row, "installation_id"), hostname: text(row, "hostname"),
      administratorEmail: text(row, "administrator_email"), invitationId: text(row, "invitation_id"), productDatabase: text(row, "product_database"), productRole: text(row, "product_role"),
      temporalNamespace: text(row, "temporal_namespace"), secretDirectory: text(row, "secret_bundle_path"), operatorDirectory: text(row, "operator_directory"), phase,
      planLimits: json<Record<string, number>>(row.plan_limits, {}), membershipRefs: json<string[]>(row.membership_refs, []), raw: row,
    });
  }

  async steps(tenantId: string): Promise<readonly FactoryStepRecord[]> {
    const rows = await this.sql`SELECT step, ordinal, owner, state, attempts, resources, failure_code, failure_message FROM factory_provisioning_steps WHERE tenant_id = ${tenantId} ORDER BY ordinal` as Row[];
    return rows.map((row) => {
      if (!isFactoryStepState(row.state)) throw new FactoryProvisioningError("provisioning_ledger_corrupt", "Step state is corrupt.");
      return Object.freeze({
        step: row.step as FactoryProvisioningStepName, ordinal: Number(row.ordinal), owner: String(row.owner), state: row.state, attempts: Number(row.attempts),
        resources: Object.freeze(json<Record<string, string>>(row.resources, {})),
        failure: row.failure_code === null ? null : Object.freeze({ code: String(row.failure_code), message: String(row.failure_message ?? "") }),
      });
    });
  }

  async stepStarted(tenantId: string, step: FactoryProvisioningStepName): Promise<void> {
    await this.sql`UPDATE factory_provisioning_steps SET state = 'running', attempts = attempts + 1, failure_code = NULL, failure_message = NULL, updated_at = now() WHERE tenant_id = ${tenantId} AND step = ${step}`;
    await this.event({ tenantId, step, event: "step.started", detail: {} });
  }

  /** Progress inside a step: resources recorded before the step completes, so a crash keeps what was created. */
  async stepProgress(tenantId: string, step: FactoryProvisioningStepName, resources: FactoryStepResources): Promise<void> {
    await this.sql`UPDATE factory_provisioning_steps SET resources = resources || ${JSON.stringify(assertFactoryStepResources(resources))}::jsonb, updated_at = now() WHERE tenant_id = ${tenantId} AND step = ${step}`;
  }

  async stepCompleted(tenantId: string, step: FactoryProvisioningStepName, resources: FactoryStepResources): Promise<void> {
    await this.sql`UPDATE factory_provisioning_steps SET state = 'complete', resources = resources || ${JSON.stringify(assertFactoryStepResources(resources))}::jsonb, failure_code = NULL, failure_message = NULL, updated_at = now(), completed_at = now() WHERE tenant_id = ${tenantId} AND step = ${step}`;
    await this.event({ tenantId, step, event: "step.completed", detail: {} });
  }

  async stepFailed(tenantId: string, step: FactoryProvisioningStepName, failure: FactoryStepFailure): Promise<void> {
    await this.sql`UPDATE factory_provisioning_steps SET state = 'failed', failure_code = ${failure.code}, failure_message = ${failure.message}, updated_at = now() WHERE tenant_id = ${tenantId} AND step = ${step}`;
    await this.event({ tenantId, step, event: "step.failed", detail: { code: failure.code } });
  }

  async stepTornDown(tenantId: string, step: FactoryProvisioningStepName, detail: Readonly<Record<string, string>> = {}): Promise<void> {
    await this.sql`UPDATE factory_provisioning_steps SET state = 'torn_down', failure_code = NULL, failure_message = NULL, updated_at = now() WHERE tenant_id = ${tenantId} AND step = ${step}`;
    await this.event({ tenantId, step, event: "step.torn_down", detail });
  }

  /** Move the installation's phase, refusing any transition the phase model forbids. */
  async setPhase(tenantId: string, to: FactoryInstallationPhase, detail: Readonly<Record<string, string>> = {}): Promise<void> {
    const current = await this.installation(tenantId);
    if (!current) throw new FactoryProvisioningError("provisioning_unknown_tenant", `No installation is recorded for ${tenantId}.`);
    if (current.phase === to) return;
    if (!factoryPhaseTransitionAllowed(current.phase, to)) throw new FactoryProvisioningError("provisioning_phase_forbidden", `An installation cannot move from ${current.phase} to ${to}.`);
    // The v1 `state` column keeps its documented meaning: `ready` means the
    // installation's resources exist and are live, nothing more.
    const legacy = ["resources_prepared", "deployment_ready", "invitation_issued", "bootstrap_complete"].includes(to) ? "ready" : "partial";
    await this.sql`UPDATE factory_installations SET phase = ${to}, state = ${legacy}, current_step = ${to}, phase_changed_at = now() WHERE tenant_id = ${tenantId} AND phase = ${current.phase}`;
    await this.event({ tenantId, step: null, event: `phase.${to}`, detail });
  }

  async addMembershipReference(tenantId: string, reference: string): Promise<void> {
    await this.sql`UPDATE factory_installations SET membership_refs = (SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements_text(membership_refs || ${JSON.stringify([reference])}::jsonb) AS value) WHERE tenant_id = ${tenantId}`;
  }

  async event(input: FactoryProvisioningEvent): Promise<void> {
    await this.sql`INSERT INTO factory_provisioning_events(tenant_id, step, event, detail) VALUES (${input.tenantId}, ${input.step}, ${input.event}, ${JSON.stringify(input.detail)}::jsonb)`;
  }

  async events(tenantId: string): Promise<readonly FactoryProvisioningEvent[]> {
    const rows = await this.sql`SELECT tenant_id, step, event, detail FROM factory_provisioning_events WHERE tenant_id = ${tenantId} ORDER BY event_id` as Row[];
    return rows.map((row) => Object.freeze({ tenantId: String(row.tenant_id), step: (row.step ?? null) as FactoryProvisioningStepName | null, event: String(row.event), detail: json<Record<string, string>>(row.detail, {}) }));
  }

  async directory(): Promise<readonly FactoryInstallationRecord[]> {
    const rows = await this.sql`SELECT tenant_id FROM factory_installations ORDER BY tenant_id` as Row[];
    const records: FactoryInstallationRecord[] = [];
    for (const row of rows) {
      const record = await this.installation(String(row.tenant_id));
      if (record) { const { raw: _raw, ...entry } = record; records.push(Object.freeze(entry)); }
    }
    return records;
  }

  /** Tenants other than `tenantId` whose recorded secret digests include any of `digests`. */
  async digestConflicts(tenantId: string, digests: readonly string[]): Promise<readonly string[]> {
    if (digests.length === 0) return [];
    const rows = await this.sql`SELECT DISTINCT tenant_id FROM factory_provisioning_steps, jsonb_each_text(resources) AS entry(key, value)
      WHERE step = 'secrets' AND tenant_id <> ${tenantId} AND entry.key LIKE '%Digest' AND entry.value = ANY(${digests}::text[]) ORDER BY tenant_id` as Row[];
    return rows.map((row) => String(row.tenant_id));
  }
}
