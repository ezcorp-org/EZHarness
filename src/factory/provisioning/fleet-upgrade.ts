/**
 * Fleet upgrades in canary-first waves, in C12's fixed component order.
 *
 * Order, per installation: the HOST components (the supervisor and the pool),
 * then the ORCHESTRATION process, then the HARNESS and its gateway. A rollback
 * walks the same list backwards. The harness goes last because it runs the
 * installation's migrations at boot, so a migration failure surfaces while
 * the host and orchestration components already run the new build and can be
 * walked back.
 *
 * A wave upgrades its canary alone first. A migration or readiness failure in
 * any installation stops the wave where it is: that installation is rolled
 * back to the build it ran before, every installation after it is left
 * untouched, and the wave is recorded `stopped` with the failure. Nothing
 * retries on its own.
 *
 * Only an installation that serves traffic is upgraded: one in
 * `invitation_issued` or `bootstrap_complete`. Any other installation is
 * skipped and named in the result. A canary that is not eligible stops the
 * wave before anything moves, because the canary is what proves the build. Each
 * installation is upgraded under the provisioner's per-tenant lock, so a wave
 * never races a rotation or a teardown of the same installation.
 *
 * At most one wave runs at a time: a partial unique index admits one `running`
 * row. A wave that throws is recorded `stopped` with the failure before the
 * error leaves this module, so no wave stays `running` after its caller
 * returns. Only a crashed process can leave a `running` row; `abandon` clears
 * it once the operator knows that process is gone.
 *
 * Builds are retained, never dropped, while anything could need them: a build
 * is retired only when no installation runs it or holds it as its rollback
 * target AND the work census of every installation that ran it reports no
 * active or uncertain work. Schema changes are additive, so rolling code back
 * leaves the newer schema in place, and the older build must boot on it — the
 * rollback's readiness check is what proves that.
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { FactoryInstallationContext } from "./installation";
import { FactoryProvisioningLedger } from "./ledger";
import type { FactoryWorkCensus } from "./local";
import { FactoryProvisioningError, factoryStepFailure, type FactoryInstallationPhase, type FactoryStepFailure } from "./steps";

export const FACTORY_UPGRADE_COMPONENTS = ["host", "orchestrator", "harness"] as const;
export type FactoryUpgradeComponent = typeof FACTORY_UPGRADE_COMPONENTS[number];

export interface FactoryBuild {
  readonly buildId: string;
  /** `registry/name@sha256:...` */
  readonly image: string;
  readonly revision: string;
  /** The host checkout the supervisor unit runs for this build. */
  readonly releaseDirectory: string;
}

export type FactoryInstallationBuilds = Readonly<Record<FactoryUpgradeComponent, FactoryBuild>>;

/** Applies one component's build to one installation, and proves the installation ready. */
export interface FactoryUpgradeTarget {
  apply(installation: FactoryInstallationContext, component: FactoryUpgradeComponent, builds: FactoryInstallationBuilds): Promise<void>;
  ready(installation: FactoryInstallationContext): Promise<void>;
}

export interface FactoryUpgradeWaveResult {
  readonly waveId: string;
  readonly state: "completed" | "stopped";
  readonly upgraded: readonly string[];
  readonly rolledBack: readonly string[];
  readonly untouched: readonly string[];
  /** Installations not upgraded because their phase serves no traffic. */
  readonly skipped: readonly { readonly tenantId: string; readonly phase: FactoryInstallationPhase | "unknown" }[];
  readonly failure: (FactoryStepFailure & { readonly tenantId: string; readonly component: FactoryUpgradeComponent }) | null;
}

/** Canary first, alone; then the rest in order. The canary must be one of the installations. */
export function planFactoryUpgradeWave(tenants: readonly string[], canary: string): readonly string[] {
  if (!tenants.includes(canary)) throw new FactoryProvisioningError("upgrade_canary_unknown", `Canary ${canary} is not an installation of this fleet.`);
  return Object.freeze([canary, ...tenants.filter((tenant) => tenant !== canary).sort()]);
}

type FactoryComponentFailure = { readonly component: FactoryUpgradeComponent; readonly failure: FactoryStepFailure };

const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UPGRADABLE: ReadonlySet<FactoryInstallationPhase> = new Set(["invitation_issued", "bootstrap_complete"]);

export class FactoryFleetUpgrades {
  /**
   * The provisioner's ledger over this module's own pool: its per-tenant lock
   * holds one connection while the upgrade's queries use another, so the pool
   * needs two connections.
   */
  private readonly ledger: FactoryProvisioningLedger;
  constructor(private readonly sql: SQL, private readonly target: FactoryUpgradeTarget, private readonly installations: (tenantId: string) => Promise<FactoryInstallationContext>) {
    this.ledger = new FactoryProvisioningLedger(sql);
  }

  async setup(): Promise<void> {
    await this.sql.begin(async (control) => {
      await control.unsafe("SELECT pg_advisory_xact_lock(hashtext('factory-upgrade-schema-v1'))");
      await control.unsafe(`CREATE TABLE IF NOT EXISTS factory_fleet_builds (
        build_id text PRIMARY KEY, image text NOT NULL, revision text NOT NULL, release_directory text NOT NULL,
        state text NOT NULL DEFAULT 'retained' CHECK (state IN ('retained', 'retired')), registered_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz)`);
      await control.unsafe(`CREATE TABLE IF NOT EXISTS factory_installation_builds (
        tenant_id text NOT NULL REFERENCES factory_installations(tenant_id),
        component text NOT NULL CHECK (component IN (${FACTORY_UPGRADE_COMPONENTS.map((component) => `'${component}'`).join(",")})),
        build_id text NOT NULL REFERENCES factory_fleet_builds(build_id),
        previous_build_id text REFERENCES factory_fleet_builds(build_id),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, component))`);
      await control.unsafe(`CREATE TABLE IF NOT EXISTS factory_upgrade_waves (
        wave_id text PRIMARY KEY, target_build_id text NOT NULL REFERENCES factory_fleet_builds(build_id), canary_tenant_id text NOT NULL,
        state text NOT NULL CHECK (state IN ('running', 'completed', 'stopped')), failure_tenant_id text, failure_component text, failure_code text, failure_message text,
        started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`);
      await control.unsafe("ALTER TABLE factory_upgrade_waves ADD COLUMN IF NOT EXISTS skipped jsonb NOT NULL DEFAULT '[]'::jsonb");
      await control.unsafe("CREATE UNIQUE INDEX IF NOT EXISTS factory_upgrade_waves_one_running ON factory_upgrade_waves ((true)) WHERE state = 'running'");
      await control.unsafe(`CREATE TABLE IF NOT EXISTS factory_upgrade_wave_steps (
        wave_id text NOT NULL REFERENCES factory_upgrade_waves(wave_id), tenant_id text NOT NULL, component text NOT NULL,
        action text NOT NULL CHECK (action IN ('upgrade', 'rollback')), state text NOT NULL CHECK (state IN ('complete', 'failed')),
        failure_code text, recorded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (wave_id, tenant_id, component, action))`);
    });
  }

  async register(build: FactoryBuild): Promise<void> {
    if (!BUILD_ID.test(build.buildId) || !/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(build.image) || !/^[a-f0-9]{40}$/.test(build.revision)) throw new FactoryProvisioningError("upgrade_build_invalid", "A build is a pinned image, a full revision, and a release directory.");
    await this.sql`INSERT INTO factory_fleet_builds(build_id, image, revision, release_directory) VALUES (${build.buildId}, ${build.image}, ${build.revision}, ${build.releaseDirectory}) ON CONFLICT (build_id) DO NOTHING`;
    const stored = await this.build(build.buildId);
    if (stored.image !== build.image || stored.revision !== build.revision || stored.releaseDirectory !== build.releaseDirectory) throw new FactoryProvisioningError("upgrade_build_conflict", `Build ${build.buildId} is already registered with different content.`);
  }

  async build(buildId: string): Promise<FactoryBuild> {
    const row = (await this.sql`SELECT build_id, image, revision, release_directory FROM factory_fleet_builds WHERE build_id = ${buildId}`)[0] as { build_id: string; image: string; revision: string; release_directory: string } | undefined;
    if (!row) throw new FactoryProvisioningError("upgrade_build_unknown", `Build ${buildId} is not registered.`);
    return Object.freeze({ buildId: row.build_id, image: row.image, revision: row.revision, releaseDirectory: row.release_directory });
  }

  /** Record the build an installation was deployed with, for every component. Idempotent. */
  async adopt(tenantId: string, buildId: string): Promise<void> {
    await this.build(buildId);
    for (const component of FACTORY_UPGRADE_COMPONENTS) await this.sql`INSERT INTO factory_installation_builds(tenant_id, component, build_id) VALUES (${tenantId}, ${component}, ${buildId}) ON CONFLICT (tenant_id, component) DO NOTHING`;
  }

  async builds(tenantId: string): Promise<FactoryInstallationBuilds | undefined> {
    const rows = await this.sql`SELECT component, build_id FROM factory_installation_builds WHERE tenant_id = ${tenantId}` as { component: FactoryUpgradeComponent; build_id: string }[];
    if (rows.length === 0) return undefined;
    const entries: Partial<Record<FactoryUpgradeComponent, FactoryBuild>> = {};
    for (const row of rows) entries[row.component] = await this.build(row.build_id);
    if (FACTORY_UPGRADE_COMPONENTS.some((component) => !entries[component])) throw new FactoryProvisioningError("upgrade_ledger_corrupt", `Installation ${tenantId} is missing a component build.`);
    return Object.freeze(entries as Record<FactoryUpgradeComponent, FactoryBuild>);
  }

  private async setComponent(tenantId: string, component: FactoryUpgradeComponent, buildId: string, previous: string | null): Promise<void> {
    await this.sql`UPDATE factory_installation_builds SET build_id = ${buildId}, previous_build_id = ${previous}, updated_at = now() WHERE tenant_id = ${tenantId} AND component = ${component}`;
  }

  private async step(waveId: string, tenantId: string, component: FactoryUpgradeComponent, action: "upgrade" | "rollback", failure?: FactoryStepFailure): Promise<void> {
    await this.sql`INSERT INTO factory_upgrade_wave_steps(wave_id, tenant_id, component, action, state, failure_code) VALUES (${waveId}, ${tenantId}, ${component}, ${action}, ${failure ? "failed" : "complete"}, ${failure?.code ?? null}) ON CONFLICT (wave_id, tenant_id, component, action) DO UPDATE SET state = EXCLUDED.state, failure_code = EXCLUDED.failure_code, recorded_at = now()`;
  }

  /**
   * Walk one installation back to the builds it ran before, in reverse order.
   * Only components this wave actually moved are walked back.
   */
  private async rollback(waveId: string, tenantId: string, moved: readonly { readonly component: FactoryUpgradeComponent; readonly previous: string }[]): Promise<void> {
    const installation = await this.installations(tenantId);
    for (const { component, previous } of [...moved].reverse()) {
      await this.setComponent(tenantId, component, previous, null);
      await this.target.apply(installation, component, (await this.builds(tenantId))!);
      await this.step(waveId, tenantId, component, "rollback");
    }
    await this.target.ready(installation);
  }

  /** Upgrade the fleet to `buildId`, canary first, stopping at the first failure. */
  async wave(input: { readonly buildId: string; readonly canary: string; readonly tenants: readonly string[] }): Promise<FactoryUpgradeWaveResult> {
    const target = await this.build(input.buildId);
    const plan = planFactoryUpgradeWave(input.tenants, input.canary);
    const waveId = randomUUID();
    // ON CONFLICT covers the partial unique index, so two waves cannot both start.
    const started = await this.sql`INSERT INTO factory_upgrade_waves(wave_id, target_build_id, canary_tenant_id, state) VALUES (${waveId}, ${target.buildId}, ${input.canary}, 'running') ON CONFLICT DO NOTHING RETURNING wave_id`;
    if (started.length === 0) {
      const running = (await this.sql`SELECT wave_id FROM factory_upgrade_waves WHERE state = 'running'`)[0] as { wave_id: string } | undefined;
      throw new FactoryProvisioningError("upgrade_wave_running", `Wave ${running?.wave_id ?? "unknown"} is still running.`);
    }
    let at: string | null = null;
    try {
      const upgraded: string[] = [];
      const skipped: { tenantId: string; phase: FactoryInstallationPhase | "unknown" }[] = [];
      for (const [index, tenantId] of plan.entries()) {
        at = tenantId;
        const outcome = await this.ledger.locked(tenantId, async (): Promise<{ readonly skipped: FactoryInstallationPhase | "unknown" } | { readonly failed: FactoryComponentFailure | undefined }> => {
          const phase: FactoryInstallationPhase | "unknown" = (await this.ledger.installation(tenantId))?.phase ?? "unknown";
          if (phase === "unknown" || !UPGRADABLE.has(phase)) {
            if (index === 0) throw new FactoryProvisioningError("upgrade_canary_ineligible", `Canary ${tenantId} is ${phase} and cannot prove the build.`);
            return { skipped: phase };
          }
          return { failed: await this.upgradeOne(waveId, tenantId, target.buildId) };
        });
        if ("skipped" in outcome) { skipped.push({ tenantId, phase: outcome.skipped }); continue; }
        if (outcome.failed) {
          const { component, failure } = outcome.failed;
          await this.finish(waveId, "stopped", skipped, { tenantId, component, failure });
          return Object.freeze({ waveId, state: "stopped", upgraded, rolledBack: [tenantId], untouched: plan.slice(index + 1), skipped, failure: { ...failure, tenantId, component } });
        }
        upgraded.push(tenantId);
      }
      await this.finish(waveId, "completed", skipped);
      return Object.freeze({ waveId, state: "completed", upgraded, rolledBack: [], untouched: [], skipped, failure: null });
    } catch (error) {
      const failure = factoryStepFailure(error);
      await this.sql`UPDATE factory_upgrade_waves SET state = 'stopped', failure_tenant_id = ${at}, failure_code = ${failure.code}, failure_message = ${failure.message}, finished_at = now() WHERE wave_id = ${waveId} AND state = 'running'`;
      throw error;
    }
  }

  /**
   * Move one installation to the target build, host first, and prove it
   * ready. On failure, walk it back and return what failed; a failure of the
   * walk-back itself throws.
   */
  private async upgradeOne(waveId: string, tenantId: string, buildId: string): Promise<FactoryComponentFailure | undefined> {
    const current = await this.builds(tenantId);
    if (!current) throw new FactoryProvisioningError("upgrade_installation_unknown", `Installation ${tenantId} has no recorded build.`);
    const installation = await this.installations(tenantId);
    const moved: { component: FactoryUpgradeComponent; previous: string }[] = [];
    let failed: { component: FactoryUpgradeComponent; failure: FactoryStepFailure } | undefined;
    for (const component of FACTORY_UPGRADE_COMPONENTS) {
      if (current[component].buildId === buildId) continue;
      moved.push({ component, previous: current[component].buildId });
      await this.setComponent(tenantId, component, buildId, current[component].buildId);
      try { await this.target.apply(installation, component, (await this.builds(tenantId))!); await this.step(waveId, tenantId, component, "upgrade"); }
      catch (error) { failed = { component, failure: factoryStepFailure(error) }; break; }
    }
    if (!failed) {
      try { await this.target.ready(installation); }
      catch (error) { failed = { component: "harness", failure: factoryStepFailure(error) }; }
    }
    if (!failed) return undefined;
    await this.step(waveId, tenantId, failed.component, "upgrade", failed.failure);
    await this.rollback(waveId, tenantId, moved);
    return failed;
  }

  private async finish(waveId: string, state: "completed" | "stopped", skipped: readonly unknown[], failed?: { readonly tenantId: string; readonly component: FactoryUpgradeComponent; readonly failure: FactoryStepFailure }): Promise<void> {
    await this.sql`UPDATE factory_upgrade_waves SET state = ${state}, skipped = ${JSON.stringify(skipped)}::jsonb, failure_tenant_id = ${failed?.tenantId ?? null}, failure_component = ${failed?.component ?? null}, failure_code = ${failed?.failure.code ?? null}, failure_message = ${failed?.failure.message ?? null}, finished_at = now() WHERE wave_id = ${waveId}`;
  }

  /**
   * Clear a wave a crashed process left `running`. The operator asserts that
   * the process is gone; the installations it touched keep whatever builds the
   * ledger records, and the next wave starts from those.
   */
  async abandon(waveId: string): Promise<void> {
    const rows = await this.sql`UPDATE factory_upgrade_waves SET state = 'stopped', failure_code = 'upgrade_wave_abandoned', failure_message = 'The operator abandoned a wave its process did not finish.', finished_at = now() WHERE wave_id = ${waveId} AND state = 'running' RETURNING wave_id`;
    if (rows.length === 0) throw new FactoryProvisioningError("upgrade_wave_not_running", `Wave ${waveId} is not running.`);
  }

  /**
   * Retire builds nothing can need. A build any installation runs or holds as
   * its rollback target is kept; so is every build an installation with open
   * work has ever run in this ledger.
   */
  async retire(census: FactoryWorkCensus): Promise<readonly string[]> {
    const referenced = new Set((await this.sql`SELECT build_id AS id FROM factory_installation_builds UNION SELECT previous_build_id FROM factory_installation_builds WHERE previous_build_id IS NOT NULL` as { id: string }[]).map((row) => row.id));
    const busyTenants: string[] = [];
    for (const row of await this.sql`SELECT DISTINCT tenant_id FROM factory_installation_builds` as { tenant_id: string }[]) {
      const open = await census.count(await this.installations(row.tenant_id));
      if (open.active > 0 || open.uncertain > 0) busyTenants.push(row.tenant_id);
    }
    if (busyTenants.length > 0) {
      for (const row of await this.sql`SELECT DISTINCT w.target_build_id AS build_id FROM factory_upgrade_wave_steps s JOIN factory_upgrade_waves w USING (wave_id) WHERE s.tenant_id = ANY(${busyTenants}::text[])` as { build_id: string }[]) referenced.add(row.build_id);
    }
    const candidates = await this.sql`SELECT build_id FROM factory_fleet_builds WHERE state = 'retained'` as { build_id: string }[];
    const retired: string[] = [];
    for (const { build_id: buildId } of candidates) {
      if (referenced.has(buildId)) continue;
      await this.sql`UPDATE factory_fleet_builds SET state = 'retired', retired_at = now() WHERE build_id = ${buildId} AND state = 'retained'`;
      retired.push(buildId);
    }
    return retired;
  }
}
