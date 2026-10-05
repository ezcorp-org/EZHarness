import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { getSandboxController } from "$server/runtime/sandbox/controller";
import { LOCAL_MVP_LIMITS, sandboxError, statusDto } from "$lib/server/sandbox-route";
import type { RequestHandler } from "./$types";

const schema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	providerInstallationId: z.string().uuid(),
	providerId: z.string().min(1).max(120),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	const body = schema.safeParse(await request.json().catch(() => null));
	if (!body.success) return json({ error: "Invalid private sandbox request" }, { status: 400, headers: { "cache-control": "no-store" } });
	const idempotencyKey = request.headers.get("Idempotency-Key");
	if (!idempotencyKey || !z.string().uuid().safeParse(idempotencyKey).success) return json({ error: "A valid Idempotency-Key is required" }, { status: 400, headers: { "cache-control": "no-store" } });
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
