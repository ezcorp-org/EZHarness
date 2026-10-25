import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth, requireAdminSession } from "$server/auth/middleware";
import { getSandboxController } from "$server/runtime/sandbox/controller";
import { LOCAL_MVP_LIMITS, sandboxError, statusDto } from "$lib/server/sandbox-route";
import type { RequestHandler } from "./$types";

const legacySchema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	providerInstallationId: z.string().uuid(),
	providerId: z.string().min(1).max(120),
});

const incusSchema = z.strictObject({
  kind: z.literal("incus"), name: z.string().trim().min(1).max(120),
  installationId: z.string().uuid(), connectionId: z.string().uuid(), presetId: z.string().min(1).max(120),
  repositoryId: z.number().int().positive().safe(), baseRef: z.string().min(1).max(255),
});
const schema = z.union([legacySchema, incusSchema]);

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	const body = schema.safeParse(await request.json().catch(() => null));
	if (!body.success) return json({ error: "Invalid private sandbox request" }, { status: 400, headers: { "cache-control": "no-store" } });
	const idempotencyKey = request.headers.get("Idempotency-Key");
	if (!idempotencyKey || !z.string().uuid().safeParse(idempotencyKey).success) return json({ error: "A valid Idempotency-Key is required" }, { status: 400, headers: { "cache-control": "no-store" } });
	if ("kind" in body.data) {
    const operator = requireAdminSession(locals);
    if (operator instanceof Response) return operator;
    try {
      const { createPrivateIncusRepository } = await import("$server/integrations/github-personal-prs/incus-import");
      const result = await createPrivateIncusRepository(operator.id, { ...body.data, idempotencyKey });
      if (!result.projectId) return json({ code: "repository_unavailable", error: "Enable the selected repository for your GitHub account before creating its workspace." }, { status: 409, headers: { "cache-control": "no-store" } });
      return json({ project: { id: result.projectId }, import: result }, { status: result.importState === "ready" ? 201 : 202, headers: { "cache-control": "no-store" } });
    } catch (error) {
      const { WorkspaceTransferError } = await import("$server/integrations/github-personal-prs/provider-transfer");
      if (error instanceof WorkspaceTransferError) {
        return json(error.code === "unsupported_workspace"
          ? { code: "incus_import_limits", error: "Repository source cannot be imported into this Incus workspace. Check file, path, and source-type limits." }
          : { code: "incus_import_partial", error: "Source import needs review. Inspect the saved workspace in Incus management before disposal; file transfer will not be repeated." },
          { status: error.code === "unsupported_workspace" ? 400 : 409, headers: { "cache-control": "no-store" } });
      }
      const { personalPrRouteError } = await import("../personal-prs/_route");
      return personalPrRouteError(error);
    }
  }
	try {
		const controller = getSandboxController();
		const admitted = await controller.createSandboxProject(user.id, {
			...body.data,
			idempotencyKey,
			privateOwnerOnly: true,
			privateInitializing: true,
			config: {},
			limits: LOCAL_MVP_LIMITS,
		});
		return json({ project: { id: admitted.projectId }, sandbox: statusDto(admitted) }, { status: 201, headers: { "cache-control": "no-store" } });
	} catch (error) {
		const response = sandboxError(error);
		response.headers.set("cache-control", "no-store");
		return response;
	}
};
