import { IncusAdmissionReadinessService } from "$server/infrastructure/incus-admission-readiness";
import { IncusAdmissionReadinessError } from "$server/infrastructure/incus-admission-contract";
import { json } from "@sveltejs/kit";
import { ContractError } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { requireAdminSession } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { releaseRows } from "$server/db/queries/extension-releases";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { getReleaseRuntime, resolveActiveRelease } from "$server/extensions/release-process";
import { IncusQualificationStore } from "$server/infrastructure/incus-qualification";
import { permitsFailedCleanupInspection } from "$server/infrastructure/incus-cleanup-stop-policy";
import type { RequestHandler } from "./$types";

const pageSize = 100;
interface Connection {
  installationId: string; releaseId: string; connectionId: string; connectionRevision: number; label: string;
  setupId: string | null;
}
interface Run { runId: string; state: string; deadlineAt: string }
type CleanupBinding = Parameters<typeof permitsFailedCleanupInspection>[0];
type CleanupJournal = Parameters<typeof permitsFailedCleanupInspection>[1];
interface FeatureRow {
  bindingId: string; generation: number; tombstonedAt: Date | null; desiredState: CleanupBinding["desiredState"];
  installationId: string; releaseId: string; connectionId: string; connectionRevision: number | null;
  cleanupConfirmedAt: Date | null; operation: { id: string } | null; cleanupJournal: CleanupJournal;
}

type ActiveRelease = Awaited<ReturnType<typeof resolveActiveRelease>>;
type Preset = NonNullable<ActiveRelease["release"]["manifest"]["sandboxProviders"]>[number]["presets"][number];

async function environmentStatus(db: ReturnType<typeof getDb>, qualifications: IncusQualificationStore,
  connection: Connection, active: ActiveRelease, preset: Preset) {
  const scope = { installationId: connection.installationId, releaseId: connection.releaseId,
    connectionId: connection.connectionId, presetId: preset.id };
  let qualification = await qualifications.load(scope);
  const fullQualificationValidUntil = qualification?.validUntil ?? null;
  let admissionReason: "qualification_expired" | "readiness_unavailable" | "capacity_full" | null = null;
  let admissionValidUntil: string | null = null;
  let baselineRunId: string | null = null;
  try {
    const ready = await new IncusAdmissionReadinessService(db, qualifications).check(scope);
    qualification = ready.qualification;
    baselineRunId = ready.baselineRunId;
    admissionValidUntil = new Date(ready.validUntil).toISOString();
  } catch (error) {
    admissionReason = error instanceof IncusAdmissionReadinessError ? error.code : "readiness_unavailable";
  }
  const [run] = releaseRows<Run>(await db.execute(sql`SELECT run_id AS "runId", state, deadline_at AS "deadlineAt"
    FROM incus_qualification_runs WHERE scope = ${JSON.stringify(scope)}::jsonb
    AND connection_revision = ${connection.connectionRevision}
    ORDER BY deadline_at DESC, run_id DESC LIMIT 1`));
  const running = run && ["AWAITING_RESTART", "CLAIMED"].includes(run.state)
    && new Date(run.deadlineAt).getTime() > Date.now();
  const failed = run && run.state !== "COMPLETED" && !running;
  return { ...connection, releaseGeneration: active.installation.generation,
    presetId: preset.id, label: `${connection.label} · ${preset.id}`, profile: preset.profile, limits: preset.limits,
    qualified: admissionReason === null && !running, qualificationValidUntil: admissionValidUntil,
    fullQualificationValidUntil: fullQualificationValidUntil ?? qualification?.validUntil ?? null, admissionReason,
    qualificationState: running ? "running" : admissionReason === null ? "qualified" : failed ? "failed" : "not_qualified",
    qualificationRunId: running ? run?.runId ?? null : admissionReason === null ? baselineRunId : run?.runId ?? null,
    lastQualificationRunId: run?.runId ?? null, baselineRunId,
    blockedReason: running ? "Qualification is running." : admissionReason === null ? null
      : admissionReason === "qualification_expired" ? "Run qualification before creating a sandbox."
        : admissionReason === "capacity_full" ? "The Incus host has no free capacity."
          : "Host readiness is unavailable. Verify the upgraded supervisor, reviewed SSH gate and authority configuration, then retry readiness." };
}

/** Read-only operator view. Actions recheck authority and qualification before admission. */
export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  try {
    await getExtensionLifecycle();
    const db = getDb();
    const connections = releaseRows<Connection>(await db.execute(sql`SELECT
      c.provider_installation_id AS "installationId", c.provider_release_id AS "releaseId",
      c.id AS "connectionId", c.revision AS "connectionRevision", c.project AS label,
      (SELECT s.id FROM incus_operator_setups s WHERE s.connection_id = c.id
        AND s.connection_revision = c.revision AND s.provider_installation_id = c.provider_installation_id
        AND s.provider_release_id = c.provider_release_id AND s.state = 'verified'
        ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS "setupId"
      FROM provider_connections c WHERE c.revoked_at IS NULL AND c.configuration->>'kind' = 'incus'
      ORDER BY c.id LIMIT ${pageSize + 1}`));
    const projects = releaseRows<{ id: string; name: string }>(await db.execute(sql`SELECT id, name
      FROM projects WHERE purpose = 'user' ORDER BY name, id LIMIT ${pageSize + 1}`));
    // Explicit columns keep configuration, certificates, journals and secret data out of the response.
    const featureRows = releaseRows<FeatureRow>(await db.execute(sql`SELECT b.project_id AS "projectId", p.name AS "projectName",
      b.id AS "bindingId", b.provider_installation_id AS "installationId", b.provider_release_id AS "releaseId",
      b.connection_id AS "connectionId", b.connection_revision AS "connectionRevision", b.generation,
      b.preset_id AS "presetId", b.desired_state AS "desiredState",
      b.observed_state AS "observedState", b.tombstoned_at AS "tombstonedAt", b.cleanup_confirmed_at AS "cleanupConfirmedAt",
      CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('id', o.id, 'kind', o.kind, 'state', o.state,
        'errorCode', o.error_code, 'providerOperationRecorded', o.provider_operation_id IS NOT NULL, 'createdAt', o.created_at, 'updatedAt', o.updated_at) END AS operation,
      CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('id', o.id, 'bindingId', o.binding_id,
        'generation', o.generation, 'kind', o.kind, 'state', o.state, 'errorCode', o.error_code,
        'providerOperationId', o.provider_operation_id, 'requestPayload', o.request_payload) END AS "cleanupJournal",
      CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id', r.id, 'state', r.state,
        'failedDestroyOperationId', r.failed_destroy_operation_id, 'stopOperationId', r.stop_operation_id,
        'destroyOperationId', r.destroy_operation_id) END AS "cleanupRecovery"
      FROM sandbox_bindings b JOIN projects p ON p.id = b.project_id
      JOIN provider_connections c ON c.id = b.connection_id
      LEFT JOIN provider_sandbox_operations o ON o.id = b.current_operation_id AND o.binding_id = b.id
      LEFT JOIN sandbox_cleanup_recoveries r ON r.binding_id = b.id
      WHERE p.purpose = 'user' AND c.configuration->>'kind' = 'incus'
      ORDER BY b.created_at DESC, b.id LIMIT ${pageSize + 1}`));
    const features = featureRows.map(({ cleanupJournal, ...feature }) => ({ ...feature,
      cleanupRecoveryEligible: !feature.cleanupConfirmedAt && permitsFailedCleanupInspection({
        id: feature.bindingId, generation: feature.generation, currentOperationId: feature.operation?.id ?? null,
        tombstonedAt: feature.tombstonedAt, desiredState: feature.desiredState,
        providerInstallationId: feature.installationId, providerReleaseId: feature.releaseId,
        connectionId: feature.connectionId, connectionRevision: feature.connectionRevision,
      }, cleanupJournal ?? undefined),
    }));
    const qualifications = new IncusQualificationStore({ db });
    const environments = [];
    let truncated = connections.length > pageSize || projects.length > pageSize || features.length > pageSize;
    for (const connection of connections.slice(0, pageSize)) {
      let active: Awaited<ReturnType<typeof resolveActiveRelease>>;
      try { active = await resolveActiveRelease(connection.installationId, getReleaseRuntime()); }
      catch (error) {
        // An inactive release is expected. A runtime or integrity failure must remain visible.
        if (error instanceof ContractError && error.code === "RELEASE_NOT_ACTIVE") continue;
        throw error;
      }
      if (active.release.id !== connection.releaseId) continue;
      const provider = active.release.manifest.sandboxProviders?.find(item => item.id === "incus" && item.kind === "sandbox");
      if (provider?.protocolMajor !== 1) continue;
      for (const preset of provider.presets) {
        if (environments.length === pageSize) { truncated = true; break; }
        environments.push(await environmentStatus(db, qualifications, connection, active, preset));
      }
    }
    return json({ environments, projects: projects.slice(0, pageSize), features: features.slice(0, pageSize), truncated },
      { headers: { "cache-control": "no-store" } });
  } catch {
    return json({ code: "management_unavailable", message: "Sandbox status is unavailable. Try refreshing." }, { status: 503 });
  }
};
