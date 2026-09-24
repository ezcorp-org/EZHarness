import { json } from "@sveltejs/kit";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { requireAdminSession } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { getReleaseRuntime, resolveActiveRelease } from "$server/extensions/release-process";
import { IncusOperatorSetupService, bootstrapFromEnvironment, loadReviewedIncusRecipe } from "$server/infrastructure/incus-operator/service";
import { ProviderConnectionStore } from "$server/infrastructure/provider-connections/store";
import { releaseRows } from "$server/db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "$server/db/queries/audit-log";
import type { RequestHandler } from "./$types";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const knownControls = new Set(["unprivileged", "projectLimits", "privateNetwork", "explicitGuestUser",
  "atomicFileReplace", "durableProcesses", "boundedOutput", "endpointProxy"]);

function unverifiedControls(message: string): string[] {
  const prefix = "Incus required controls are unavailable: ";
  if (!message.startsWith(prefix)) return [];
  const controls = message.slice(prefix.length).split(", ");
  return controls.length && controls.every(control => knownControls.has(control)) ? controls : [];
}

function runnerReason(message: string): string | undefined {
  if (unverifiedControls(message).length) return "unverified_guest_controls";
  const reasons: Record<string, string> = {
    "Host capability denied or failed": "host_transport_denied",
    "The Incus service is unavailable": "incus_service_unavailable",
    "The Incus request was denied": "incus_request_denied",
    "The Incus request deadline was exceeded": "incus_request_timeout",
    "The Incus transport failed": "incus_transport_failed",
    "Incus helper version pin does not match": "helper_version_unverified",
    "Incus nested Compose support is unavailable": "nested_compose_unverified",
  };
  return Object.hasOwn(reasons, message) ? reasons[message] : undefined;
}

async function service(requireRecipe = false): Promise<IncusOperatorSetupService | Response> {
  const bootstrap = bootstrapFromEnvironment();
  if (!bootstrap) return json({ code: "bootstrap_not_configured", message: "Set the host-owned Incus SSH target, key, known_hosts pin, and HTTPS endpoint." }, { status: 503 });
  const recipePath = requireRecipe ? process.env.EZCORP_INCUS_SETUP_RECIPE_FILE : undefined;
  if (requireRecipe && !recipePath) return json({ code: "recipe_not_configured", message: "Set the host-owned reviewed Incus recipe file." }, { status: 503 });
  const recipe = recipePath ? loadReviewedIncusRecipe(recipePath) : undefined;
  await getExtensionLifecycle();
  const database = getDb();
  return new IncusOperatorSetupService({ database, connections: new ProviderConnectionStore(database), bootstrap, ...(recipe ? { recipe } : {}),
    activeRelease: installationId => resolveActiveRelease(installationId, getReleaseRuntime()) });
}

function safeError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Incus setup failed";
  // Provider invocation errors cross a process boundary. Only expose stable
  // codes and the bounded control names that this host probe can attest.
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "UNSUPPORTED_PROVIDER") {
    const controls = unverifiedControls(message);
    const detail = controls.length ? ` Unverified controls: ${controls.join(", ")}.` : "";
    return json({ code: "provider_preflight_unverified",
      message: `Incus provider preflight could not verify the required capabilities.${detail}` }, { status: 409 });
  }
  const providerErrors: Record<string, string> = {
    UNAVAILABLE: "Incus provider transport is unavailable. Check the HTTPS endpoint, server pin, and client trust.",
    PERMISSION_DENIED: "Incus provider request was denied. Check the pinned endpoint and client trust.",
    DEADLINE_EXCEEDED: "Incus provider probe timed out.",
    INVALID_PROVIDER_CONFIG: "Incus provider connection configuration is invalid.",
    RELEASE_CHANGED: "Incus provider release changed during the probe.",
  };
  if (typeof code === "string" && Object.hasOwn(providerErrors, code)) {
    return json({ code: "provider_probe_failed", message: providerErrors[code] }, { status: 409 });
  }
  const known = /^(The (active approved release|provider release|exact ready plan|setup is already|setup outcome)|Incus (setup was not found|setup endpoint|did not report|server certificate|provider|client identity)|Reviewed Incus (recipe|client identity)|Retired provider connection has unfinished sandboxes|Host-owned SSH|SSH (connection|host is not pinned|known_hosts)|OpenSSL is required|Verify the reviewed|Provider release|Provider connection|setup plan digest mismatch)/.test(message);
  if (known) return json({ code: "setup_failed", message }, { status: 409 });
  const record = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : undefined;
  const name = error instanceof Error ? error.name : record?.name;
  const errorType = typeof name === "string" && ["Error", "ContractError", "LifecycleError", "TypeError",
    "IncusTransportError", "RunnerError"].includes(name) ? name : "unknown";
  const errorCode = typeof code === "string" && ["CAPABILITY_UNAVAILABLE", "CAPABILITY_DENIED", "RUNNER_UNAVAILABLE",
    "RELEASE_NOT_ACTIVE", "EXPIRED_CONTEXT", "INVALID_CONTEXT", "CONTEXT_MISMATCH", "INVALID_CALL_TOKEN",
    "INVALID_REQUEST", "INTERNAL", "UNDECLARED_CONTRIBUTION", "INVALID_PROVIDER_VALUE",
    "extension_error", "runner_failed", "protocol_error", "dependency_unavailable"].includes(code) ? code : undefined;
  // A fixed label for the first stack frame narrows the failing boundary
  // without returning a raw stack, path, network address, or secret.
  const firstFrame = error instanceof Error ? error.stack?.split("\n")[1] ?? "" : "";
  const source = firstFrame.includes("incus-operator/service") ? "operator_setup"
    : firstFrame.includes("provider-connections/store") ? "connection_store"
    : firstFrame.includes("provider-rpc-broker") ? "provider_broker"
    : firstFrame.includes("release-process") ? "release_process"
    : firstFrame.includes("incus-transport/") ? "incus_transport" : "other";
  const shape = typeof error === "string" ? "string" : Array.isArray(error) ? "array"
    : record ? "object" : error === null ? "null" : "other";
  const boundedRunnerReason = errorType === "RunnerError" && code === "extension_error" ? runnerReason(message) : undefined;
  return json({ code: "setup_failed", message: "Incus setup failed. Check host logs and inspect the saved plan.",
    diagnostic: { errorType, ...(errorCode ? { errorCode } : {}), source, shape,
      ...(boundedRunnerReason ? { runnerReason: boundedRunnerReason } : {}),
      ...(record ? { hasMessage: typeof record.message === "string", hasError: Object.hasOwn(record, "error"),
        hasKind: Object.hasOwn(record, "kind"), hasStatus: Object.hasOwn(record, "status") } : {}) } }, { status: 409 });
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
  const allowed = action === "plan" ? ["action", "installationId"] : action === "apply" || action === "approve-gate-plan" ? ["action", "setupId", "planDigest"] :
    action === "probe" || action === "gate-policy" ? ["action", "setupId"] : [];
  if (!allowed.length || Object.keys(input).sort().join(",") !== [...allowed].sort().join(",")) {
    return json({ code: "invalid_input", message: "Use only the fields for the selected setup action." }, { status: 400 });
  }
  if (action === "plan" && (typeof input.installationId !== "string" || !identifier.test(input.installationId)) ||
    action !== "plan" && (typeof input.setupId !== "string" || !identifier.test(input.setupId)) ||
    (action === "apply" || action === "approve-gate-plan") && (typeof input.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.planDigest))) {
    return json({ code: "invalid_input", message: "The setup ID or plan digest is invalid." }, { status: 400 });
  }
  try {
    const configured = await service(action === "plan");
    if (configured instanceof Response) return configured;
    if (action === "plan") return json({ setup: await configured.plan(input.installationId as string, user.id) });
    if (action === "approve-gate-plan") return json({ setup: await configured.approveGatePlan(input.setupId as string, input.planDigest as string, user.id) });
    if (action === "apply") return json({ setup: await configured.apply(input.setupId as string, input.planDigest as string, user.id) });
    if (action === "gate-policy") {
      const setupId = input.setupId as string;
      const policy = await configured.gatePolicy(setupId);
      await insertTransactionalAuditEntry(getDb(), randomUUID(), user.id, "incus:gate-policy-exported", setupId,
        { planDigest: policy.planDigest, commandCount: policy.commands.length });
      return json({ policy });
    }
    return json(await configured.probe(input.setupId as string));
  } catch (error) { return safeError(error); }
};
