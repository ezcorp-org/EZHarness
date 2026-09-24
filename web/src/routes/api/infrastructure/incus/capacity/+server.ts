import { json } from "@sveltejs/kit";
import { requireAdminSession } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { getReleaseRuntime, resolveActiveRelease } from "$server/extensions/release-process";
import { IncusCapacityService, type IncusCapacityPlan } from "$server/infrastructure/incus-operator/capacity";
import { bootstrapFromEnvironment } from "$server/infrastructure/incus-operator/service";
import { ProviderConnectionStore } from "$server/infrastructure/provider-connections/store";
import type { RequestHandler } from "./$types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const defaultDependencies = { bootstrapFromEnvironment, getExtensionLifecycle, getDb, ProviderConnectionStore,
  IncusCapacityService, resolveActiveRelease, getReleaseRuntime };

export async function _createService(dependencies: typeof defaultDependencies): Promise<IncusCapacityService | null> {
  const bootstrap = dependencies.bootstrapFromEnvironment();
  if (!bootstrap) return null;
  await dependencies.getExtensionLifecycle();
  const database = dependencies.getDb();
  return new dependencies.IncusCapacityService({ database, connections: new dependencies.ProviderConnectionStore(database), bootstrap: bootstrap.ssh,
    activeRelease: installationId => dependencies.resolveActiveRelease(installationId, dependencies.getReleaseRuntime()) });
}

async function boundedBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16 * 1024) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function _createCapacityHandlers(resolveService: () => Promise<IncusCapacityService | null>) {
const GET: RequestHandler = async ({ locals, url }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  const setupId = url.searchParams.get("setupId");
  if (!setupId || !ID.test(setupId)) return json({ code: "invalid_input" }, { status: 400 });
  try {
    const configured = await resolveService();
    if (!configured) return json({ code: "bootstrap_not_configured" }, { status: 503 });
    return json({ receipt: await configured.status(setupId) });
  } catch { return json({ code: "capacity_unavailable" }, { status: 409 }); }
};

const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ code: "forbidden", message: "Capacity review must come from this site." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ code: "invalid_input", message: "Provide a JSON capacity action." }, { status: 400 });
  }
  const body = await boundedBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ code: "invalid_input" }, { status: 400 });
  const input = body as Record<string, unknown>;
  const keys = input.action === "plan" ? ["action", "setupId"] : input.action === "apply" ? ["action", "plan", "planDigest"] : [];
  if (!keys.length || Object.keys(input).sort().join(",") !== keys.sort().join(",") ||
    input.action === "plan" && (typeof input.setupId !== "string" || !ID.test(input.setupId)) ||
    input.action === "apply" && (typeof input.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.planDigest)
      || !input.plan || typeof input.plan !== "object" || Array.isArray(input.plan))) {
    return json({ code: "invalid_input", message: "Provide the exact setup or reviewed capacity plan." }, { status: 400 });
  }
  try {
    const configured = await resolveService();
    if (!configured) return json({ code: "bootstrap_not_configured" }, { status: 503 });
    if (input.action === "plan") return json({ plan: await configured.plan(input.setupId as string) });
    return json({ receipt: await configured.apply(input.plan as IncusCapacityPlan, input.planDigest as string, admin.id) });
  } catch {
    return json({ code: "capacity_unavailable", message: "Capacity could not be planned or applied. Inspect the verified setup, host headroom, and server logs." }, { status: 409 });
  }
};
return { GET, POST };
}

export const { GET, POST } = _createCapacityHandlers(() => _createService(defaultDependencies));
