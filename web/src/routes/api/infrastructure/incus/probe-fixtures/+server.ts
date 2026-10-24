import { json } from "@sveltejs/kit";
import { requireAdminSession } from "$server/auth/middleware";
import { IncusLiveProbeFixtureService } from "$server/infrastructure/incus-live-probe-fixtures";
import type { IncusQualificationScope } from "$server/infrastructure/incus-qualification";
import type { RequestHandler } from "./$types";

type Action = "plan" | "apply" | "status" | "cleanup";
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;
const baseFields = ["action", "installationId", "releaseId", "connectionId", "presetId", "operationId"];

function parse(value: unknown): { action: Action; scope: IncusQualificationScope;
  operationId: string; planDigest?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action !== "plan" && input.action !== "apply"
    && input.action !== "status" && input.action !== "cleanup") return null;
  const digestRequired = input.action === "apply" || input.action === "cleanup";
  const allowed = digestRequired ? [...baseFields, "planDigest"] : baseFields;
  if (Object.keys(input).sort().join(",") !== [...allowed].sort().join(",")) return null;
  if (baseFields.slice(1).some(field => typeof input[field] !== "string" || !identifier.test(input[field]))) return null;
  if (digestRequired && (typeof input.planDigest !== "string" || !sha256.test(input.planDigest))) return null;
  return { action: input.action, operationId: input.operationId as string,
    planDigest: digestRequired ? input.planDigest as string : undefined,
    scope: { installationId: input.installationId as string, releaseId: input.releaseId as string,
      connectionId: input.connectionId as string, presetId: input.presetId as string } };
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ code: "forbidden", message: "The probe fixture action must come from this site." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ code: "invalid_input", message: "Provide a JSON probe fixture action." }, { status: 400 });
  }
  const input = parse(await request.json().catch(() => null));
  if (!input) return json({ code: "invalid_input", message: "Provide exact probe fixture scope and operation ID." }, { status: 400 });
  const rootDirectory = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  if (!rootDirectory) return json({ code: "probe_root_not_configured",
    message: "Set the private AMD control probe directory on the EZHarness host." }, { status: 503 });
  try {
    const service = new IncusLiveProbeFixtureService({ rootDirectory });
    if (input.action === "plan") return json({ plan: await service.plan(input.scope, input.operationId) });
    if (input.action === "status") return json(await service.status(input.scope, input.operationId));
    if (input.action === "apply") return json(await service.apply(input.scope, input.operationId, input.planDigest!));
    return json({ receipt: await service.cleanup(input.scope, input.operationId, input.planDigest!) });
  } catch {
    return json({ code: "probe_fixture_unavailable",
      message: "The Incus probe fixture is unavailable for this scope. Check host logs and its saved status." }, { status: 409 });
  }
};
