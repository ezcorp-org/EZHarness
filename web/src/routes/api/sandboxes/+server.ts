import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getSandboxController } from "$server/runtime/sandbox/controller";
import { LOCAL_MVP_LIMITS, sandboxError, statusDto } from "$lib/server/sandbox-route";
import { errorJson } from "$lib/server/http-errors";
import { disableBunRequestIdleTimeout } from "$lib/server/bun-request-timeout";
import type { RequestHandler } from "./$types";

const createBody = z.object({
	name: z.string().trim().min(1).max(120),
	providerInstallationId: z.string().uuid(),
	providerId: z.string().min(1).max(120),
}).strict();

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const scopeErr = requireScope(locals, "write");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	const parsed = createBody.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return errorJson(400, "Invalid sandbox request");
	const idempotencyKey = request.headers.get("Idempotency-Key");
	if (!idempotencyKey || !z.string().uuid().safeParse(idempotencyKey).success) return errorJson(400, "A valid Idempotency-Key is required");
	try {
		const controller = getSandboxController();
		const admitted = await controller.createSandboxProject(user.id, {
			...parsed.data,
			idempotencyKey,
			config: {},
			limits: LOCAL_MVP_LIMITS,
		});
		if (!admitted.operation?.id) return errorJson(409, "Sandbox creation was not admitted");
		disableBunRequestIdleTimeout(platform);
		await controller.executeAdmittedLocalSandboxOperation(user.id, admitted.operation.id);
		const status = await controller.getProjectSandboxStatus(user.id, admitted.projectId);
		return json({ project: { id: status.projectId }, sandbox: statusDto(status) }, { status: 201 });
	} catch (error) {
		return sandboxError(error);
	}
};
