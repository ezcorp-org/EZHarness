import { json } from "@sveltejs/kit";
import { desc, eq } from "drizzle-orm";
import { checkProjectRole, requireAdminSession } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { projects, sandboxBindings, sandboxOperations } from "$server/db/schema";
import { IncusFeatureService } from "$server/infrastructure/incus-feature-service";
import { IncusQualificationStore } from "$server/infrastructure/incus-qualification";
import type { RequestHandler } from "./$types";

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

type Action = "prepare" | "create" | "start" | "stop" | "destroy" | "status" | "reconcile";
const fields: Record<Action, readonly string[]> = {
  prepare: ["action", "projectId", "installationId", "connectionId", "presetId"],
  create: ["action", "projectId", "bindingId", "idempotencyScope", "idempotencyKey"],
  start: ["action", "projectId", "bindingId", "idempotencyScope", "idempotencyKey"],
  stop: ["action", "projectId", "bindingId", "idempotencyScope", "idempotencyKey"],
  destroy: ["action", "projectId", "bindingId", "idempotencyScope", "idempotencyKey"],
  status: ["action", "projectId", "bindingId"],
  reconcile: ["action", "limit"],
};

function invalid(): Response {
  return json({ code: "invalid_input", message: "Use the exact fields and identifiers for the selected Incus feature action." }, { status: 400 });
}

function parse(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (typeof action !== "string" || !(action in fields)) return null;
  const expected = fields[action as Action];
  const supplied = Object.keys(input);
  const actual = action === "reconcile" && !Object.hasOwn(input, "limit") ? ["action"] : supplied;
  const allowed = action === "reconcile" && !Object.hasOwn(input, "limit") ? ["action"] : expected;
  if (actual.sort().join(",") !== [...allowed].sort().join(",")) return null;
  for (const field of expected) {
    if (field === "action" || field === "limit") continue;
    if (typeof input[field] !== "string" || !identifier.test(input[field])) return null;
  }
  if (action === "reconcile" && Object.hasOwn(input, "limit") && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) return null;
  return input;
}

async function authorizeProject(locals: Parameters<typeof checkProjectRole>[0], projectId: string): Promise<Response | null> {
  const role = await checkProjectRole(locals, projectId, "member");
  if (role instanceof Response) return role;
  const [project] = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return project?.id === projectId ? null : json({ code: "not_found", message: "Project was not found." }, { status: 404 });
}

async function scopedBinding(bindingId: string, projectId: string): Promise<typeof sandboxBindings.$inferSelect | Response> {
  const [binding] = await getDb().select().from(sandboxBindings).where(eq(sandboxBindings.id, bindingId)).limit(1);
  return binding?.projectId === projectId ? binding : json({ code: "not_found", message: "Feature sandbox was not found in this project." }, { status: 404 });
}

function service(): IncusFeatureService {
  const qualifications = new IncusQualificationStore({ db: getDb() });
  return new IncusFeatureService({ loadQualification: scope => qualifications.load(scope) });
}

function safeFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("qualification") || message.includes("admission") || message.includes("capacity")) {
    return json({ code: "feature_unavailable", message: "The Incus feature sandbox is not qualified or has no available capacity." }, { status: 409 });
  }
  return json({ code: "feature_failed", message: "The Incus feature sandbox request could not complete. Inspect its saved status." }, { status: 409 });
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) {
    return json({ code: "forbidden", message: "The feature action must come from this site." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return invalid();
  const input = parse(await request.json().catch(() => null));
  if (!input) return invalid();
  const action = input.action as Action;
  try {
    if (action === "reconcile") return json({ result: await service().reconcile(input.limit as number | undefined) });
    const projectId = input.projectId as string;
    const denied = await authorizeProject(locals, projectId);
    if (denied) return denied;
    if (action === "prepare") {
      const binding = await service().prepare({ projectId, installationId: input.installationId as string,
        connectionId: input.connectionId as string, presetId: input.presetId as string });
      return json({ binding });
    }
    const bindingId = input.bindingId as string;
    const binding = await scopedBinding(bindingId, projectId);
    if (binding instanceof Response) return binding;
    if (action === "status") {
      const [operation] = await getDb().select({ id: sandboxOperations.id, kind: sandboxOperations.kind,
        state: sandboxOperations.state, generation: sandboxOperations.generation,
        providerOperationId: sandboxOperations.providerOperationId, errorCode: sandboxOperations.errorCode,
        createdAt: sandboxOperations.createdAt, updatedAt: sandboxOperations.updatedAt })
        .from(sandboxOperations).where(eq(sandboxOperations.bindingId, bindingId))
        .orderBy(desc(sandboxOperations.createdAt)).limit(1);
      return json({ binding, operation: operation ?? null });
    }
    const mutation = { bindingId, idempotencyScope: input.idempotencyScope as string, idempotencyKey: input.idempotencyKey as string };
    const configured = service();
    if (action === "create" || action === "start") {
      const effect = action === "create" ? await configured.create(mutation) : await configured.start(mutation);
      return json(effect, { status: effect.state === "REJECTED" ? 409 : 202 });
    }
    if (action === "stop") return json({ operation: await configured.stop(mutation) }, { status: 202 });
    return json({ operation: await configured.destroy(mutation) }, { status: 202 });
  } catch (error) { return safeFailure(error); }
};
