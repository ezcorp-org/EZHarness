import { json } from "@sveltejs/kit";
import { sql } from "drizzle-orm";
import { requireAdminSession } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { getReleaseRuntime, resolveActiveRelease } from "$server/extensions/release-process";
import { IncusOperatorSetupService, bootstrapFromEnvironment } from "$server/infrastructure/incus-operator/service";
import { ProviderConnectionStore } from "$server/infrastructure/provider-connections/store";
import { releaseRows } from "$server/db/queries/extension-releases";
import type { RequestHandler } from "./$types";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

async function service(): Promise<IncusOperatorSetupService | Response> {
  const bootstrap = bootstrapFromEnvironment();
  if (!bootstrap) return json({ code: "bootstrap_not_configured", message: "Set the host-owned Incus SSH target, key, known_hosts pin, and HTTPS endpoint." }, { status: 503 });
  await getExtensionLifecycle();
  const database = getDb();
  return new IncusOperatorSetupService({ database, connections: new ProviderConnectionStore(database), bootstrap,
    activeRelease: installationId => resolveActiveRelease(installationId, getReleaseRuntime()) });
}

function safeError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Incus setup failed";
  const known = /^(The (active approved release|provider release|exact ready plan|setup is already|setup outcome)|Incus (setup was not found|setup endpoint|did not report|server certificate|provider|client identity)|Host-owned SSH|SSH (connection|host is not pinned|known_hosts)|OpenSSL is required|Verify the reviewed|Provider release|Provider connection|setup plan digest mismatch)/.test(message);
  return json({ code: "setup_failed", message: known ? message : "Incus setup failed. Check host logs and inspect the saved plan." }, { status: 409 });
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireAdminSession(locals);
  if (user instanceof Response) return user;
  const installationId = url.searchParams.get("installationId");
  if (installationId && !identifier.test(installationId)) return json({ code: "invalid_input", message: "Provide a valid installation ID." }, { status: 400 });
  try {
    const configured = await service();
    if (configured instanceof Response) return configured;
    if (!installationId) {
      const records = releaseRows<{ id: string }>(await getDb().execute(sql`SELECT id FROM extension_release_installations ORDER BY id LIMIT 100`));
      const installations: Array<{ id: string; releaseId: string; generation: number; inactive?: boolean }> = [];
      for (const record of records) {
        try {
          const active = await resolveActiveRelease(record.id, getReleaseRuntime());
          if (active.release.manifest.sandboxProviders?.some(provider => provider.id === "incus" && provider.kind === "sandbox")) {
            installations.push({ id: record.id, releaseId: active.release.id, generation: active.installation.generation });
          }
        } catch { /* Other extensions and inactive releases do not appear. */ }
      }
      const prior = releaseRows<{ id: string; releaseId: string; generation: number }>(await getDb().execute(sql`
        SELECT provider_installation_id AS id, provider_release_id AS "releaseId", provider_generation AS generation
        FROM incus_operator_setups ORDER BY created_at DESC LIMIT 100`));
      for (const saved of prior) if (!installations.some(active => active.id === saved.id)) {
        installations.push({ ...saved, inactive: true });
      }
      return json({ installations });
    }
    return json({ setup: await configured.latest(installationId) });
  } catch (error) { return safeError(error); }
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireAdminSession(locals);
  if (user instanceof Response) return user;
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ code: "invalid_input", message: "Provide a setup action." }, { status: 400 });
  const input = body as Record<string, unknown>;
  const action = input.action;
  const allowed = action === "plan" ? ["action", "installationId"] : action === "apply" ? ["action", "setupId", "planDigest"] : action === "probe" ? ["action", "setupId"] : [];
  if (!allowed.length || Object.keys(input).sort().join(",") !== [...allowed].sort().join(",")) {
    return json({ code: "invalid_input", message: "Use only the fields for the selected setup action." }, { status: 400 });
  }
  if (action === "plan" && (typeof input.installationId !== "string" || !identifier.test(input.installationId)) ||
    action !== "plan" && (typeof input.setupId !== "string" || !identifier.test(input.setupId)) ||
    action === "apply" && (typeof input.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.planDigest))) {
    return json({ code: "invalid_input", message: "The setup ID or plan digest is invalid." }, { status: 400 });
  }
  try {
    const configured = await service();
    if (configured instanceof Response) return configured;
    if (action === "plan") return json({ setup: await configured.plan(input.installationId as string, user.id) });
    if (action === "apply") return json({ setup: await configured.apply(input.setupId as string, input.planDigest as string, user.id) });
    return json(await configured.probe(input.setupId as string));
  } catch (error) { return safeError(error); }
};
