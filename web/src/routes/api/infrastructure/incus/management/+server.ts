import { json } from "@sveltejs/kit";
import { sql } from "drizzle-orm";
import { requireAdminSession } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { releaseRows } from "$server/db/queries/extension-releases";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { getReleaseRuntime, resolveActiveRelease } from "$server/extensions/release-process";
import { IncusQualificationStore } from "$server/infrastructure/incus-qualification";
import type { RequestHandler } from "./$types";

const pageSize = 100;
interface Connection {
  installationId: string; releaseId: string; connectionId: string; connectionRevision: number; label: string;
}
interface Run { runId: string; state: string; deadlineAt: string }

/** Read-only operator view. Actions recheck authority and qualification before admission. */
export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  try {
    await getExtensionLifecycle();
    const db = getDb();
    const connections = releaseRows<Connection>(await db.execute(sql`SELECT
      provider_installation_id AS "installationId", provider_release_id AS "releaseId",
      id AS "connectionId", revision AS "connectionRevision", project AS label
      FROM provider_connections WHERE revoked_at IS NULL AND configuration->>'kind' = 'incus'
      ORDER BY id LIMIT ${pageSize + 1}`));
    const projects = releaseRows<{ id: string; name: string }>(await db.execute(sql`SELECT id, name
      FROM projects WHERE purpose = 'user' ORDER BY name, id LIMIT ${pageSize + 1}`));
    // Explicit columns keep configuration, certificates, journals and secret data out of the response.
    const features = releaseRows(await db.execute(sql`SELECT b.project_id AS "projectId", p.name AS "projectName",
      b.id AS "bindingId", b.provider_installation_id AS "installationId", b.provider_release_id AS "releaseId",
      b.connection_id AS "connectionId", b.preset_id AS "presetId", b.desired_state AS "desiredState",
      b.observed_state AS "observedState", b.tombstoned_at AS "tombstonedAt", b.cleanup_confirmed_at AS "cleanupConfirmedAt",
      CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('id', o.id, 'kind', o.kind, 'state', o.state,
        'errorCode', o.error_code, 'createdAt', o.created_at, 'updatedAt', o.updated_at) END AS operation
      FROM sandbox_bindings b JOIN projects p ON p.id = b.project_id
      JOIN provider_connections c ON c.id = b.connection_id
      LEFT JOIN provider_sandbox_operations o ON o.id = b.current_operation_id AND o.binding_id = b.id
      WHERE p.purpose = 'user' AND c.configuration->>'kind' = 'incus'
      ORDER BY b.created_at DESC, b.id LIMIT ${pageSize + 1}`));
    const qualifications = new IncusQualificationStore({ db });
    const environments = [];
    let truncated = connections.length > pageSize || projects.length > pageSize || features.length > pageSize;
    for (const connection of connections.slice(0, pageSize)) {
      let active: Awaited<ReturnType<typeof resolveActiveRelease>>;
      try { active = await resolveActiveRelease(connection.installationId, getReleaseRuntime()); }
      catch { continue; } // Inactive releases cannot admit a new sandbox; their existing bindings remain visible.
      if (active.release.id !== connection.releaseId) continue;
      const provider = active.release.manifest.sandboxProviders?.find(item => item.id === "incus" && item.kind === "sandbox");
      if (provider?.protocolMajor !== 1) continue;
      for (const preset of provider.presets) {
        if (environments.length === pageSize) { truncated = true; break; }
        const scope = { installationId: connection.installationId, releaseId: connection.releaseId,
          connectionId: connection.connectionId, presetId: preset.id };
        const qualification = await qualifications.load(scope);
        const [run] = releaseRows<Run>(await db.execute(sql`SELECT run_id AS "runId", state, deadline_at AS "deadlineAt"
          FROM incus_qualification_runs WHERE scope = ${JSON.stringify(scope)}::jsonb
          AND connection_revision = ${connection.connectionRevision}
          ORDER BY deadline_at DESC, run_id DESC LIMIT 1`));
        const running = run && ["AWAITING_RESTART", "CLAIMED"].includes(run.state)
          && new Date(run.deadlineAt).getTime() > Date.now();
        environments.push({ ...connection, releaseGeneration: active.installation.generation,
          presetId: preset.id, label: `${connection.label} · ${preset.id}`, profile: preset.profile,
          qualified: qualification !== null, qualificationValidUntil: qualification?.validUntil ?? null,
          qualificationState: qualification ? "qualified" : running ? "running" : run ? "failed" : "not_qualified",
          qualificationRunId: run?.runId ?? null,
          blockedReason: qualification ? null : running ? "Qualification is running."
            : "Run qualification before creating a sandbox." });
      }
    }
    return json({ environments, projects: projects.slice(0, pageSize), features: features.slice(0, pageSize), truncated },
      { headers: { "cache-control": "no-store" } });
  } catch {
    return json({ code: "management_unavailable", message: "Sandbox status is unavailable. Try refreshing." }, { status: 503 });
  }
};
