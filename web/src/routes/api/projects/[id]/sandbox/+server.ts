import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getSandboxController } from "$server/runtime/sandbox/controller";
import { errorJson } from "$lib/server/http-errors";
import { sandboxError, statusDto } from "$lib/server/sandbox-route";
import { disableBunRequestIdleTimeout } from "$lib/server/bun-request-timeout";
import type { RequestHandler } from "./$types";

const actionBody = z.object({ action: z.enum(["start", "stop", "destroy"]) }).strict();

export const GET: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	try {
		return json(statusDto(await getSandboxController().getProjectSandboxStatus(user.id, params.id)));
	} catch (error) {
		return sandboxError(error);
	}
};

export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const scopeErr = requireScope(locals, "write");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	const parsed = actionBody.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return errorJson(400, "Invalid sandbox action");
	const idempotencyKey = request.headers.get("Idempotency-Key");
	if (!idempotencyKey || !z.string().uuid().safeParse(idempotencyKey).success) return errorJson(400, "A valid Idempotency-Key is required");
	try {
		const controller = getSandboxController();
		const operation = await controller.requestSandboxAction(user.id, params.id, {
			action: parsed.data.action,
			idempotencyKey,
		});
		disableBunRequestIdleTimeout(platform);
		await controller.executeAdmittedLocalSandboxOperation(user.id, operation.id);
		return json(statusDto(await controller.getProjectSandboxStatus(user.id, params.id)));
	} catch (error) {
		return sandboxError(error);
	}
};
