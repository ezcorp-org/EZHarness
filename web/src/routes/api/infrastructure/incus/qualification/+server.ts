import { json } from "@sveltejs/kit";
import { requireAdminSession } from "$server/auth/middleware";
import { IncusQualificationFixtureService, type IncusQualificationScope } from "$server/infrastructure/incus-qualification";
import type { RequestHandler } from "./$types";

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type Action = "create" | "status" | "destroy" | "start" | "stop";
const fields = ["action", "installationId", "releaseId", "connectionId", "presetId", "operationId"];

function parse(value: unknown): { action: Action; scope: IncusQualificationScope; operationId: string; powerOperationId?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action !== "create" && input.action !== "status" && input.action !== "destroy"
    && input.action !== "start" && input.action !== "stop") return null;
  const power = input.action === "start" || input.action === "stop";
  const expected = power ? [...fields, "powerOperationId"] : fields;
  if (Object.keys(input).sort().join(",") !== [...expected].sort().join(",")) return null;
  for (const field of fields.slice(1)) if (typeof input[field] !== "string" || !identifier.test(input[field])) return null;
  if (power && (typeof input.powerOperationId !== "string" || !identifier.test(input.powerOperationId))) return null;
  return { action: input.action, operationId: input.operationId as string,
    powerOperationId: power ? input.powerOperationId as string : undefined,
    scope: { installationId: input.installationId as string, releaseId: input.releaseId as string,
      connectionId: input.connectionId as string, presetId: input.presetId as string } };
}

function operationState(operation: Awaited<ReturnType<IncusQualificationFixtureService["create"]>>) {
  return { id: operation.id, kind: operation.kind, state: operation.state,
    generation: operation.generation, providerOperationId: operation.providerOperationId,
    errorCode: operation.errorCode, createdAt: operation.createdAt, updatedAt: operation.updatedAt };
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ code: "forbidden", message: "The qualification action must come from this site." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ code: "invalid_input", message: "Provide a JSON qualification action." }, { status: 400 });
  }
  const input = parse(await request.json().catch(() => null));
  if (!input) return json({ code: "invalid_input", message: "Provide exact qualification scope and operation ID." }, { status: 400 });
  try {
    const service = new IncusQualificationFixtureService();
    if (input.action === "status") return json(await service.status(input.scope, input.operationId));
    const operation = input.action === "create" ? await service.create(input.scope, input.operationId)
      : input.action === "destroy" ? await service.destroy(input.scope, input.operationId)
        : await service.setPower(input.scope, input.operationId,
          input.action === "start" ? "running" : "stopped", input.powerOperationId!);
    return json({ operation: operationState(operation) }, { status: 202 });
  } catch {
    return json({ code: "qualification_unavailable",
      message: "The Incus qualification fixture is unavailable for this scope. Check host logs and its saved status." }, { status: 409 });
  }
};
