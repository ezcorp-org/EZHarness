import { errorJson } from "$lib/server/http-errors";
import {
	SandboxControllerError,
	type LocalSandboxProvider,
	type SandboxProjectStatus,
} from "$server/runtime/sandbox/controller";

export const LOCAL_MVP_LIMITS = Object.freeze({
	memoryBytes: 512 * 1024 ** 2,
	milliCpu: 1000,
	pids: 64,
	diskBytes: 1024 ** 3,
});

export function sandboxError(error: unknown): Response {
	if (!(error instanceof SandboxControllerError)) return errorJson(503, "Local sandbox service is unavailable");
	if (error.code === "PROJECT_ACCESS_DENIED") return errorJson(403, error.message);
	if (error.code === "SANDBOX_CONTROLLER_UNAVAILABLE") return errorJson(503, error.message);
	return errorJson(409, error.message, { code: error.code });
}

export function providerDto(provider: LocalSandboxProvider) {
	return {
		installationId: provider.installationId,
		providerId: provider.providerId,
		label: provider.providerId,
		ready: true,
	};
}

export function statusDto(status: SandboxProjectStatus) {
	return {
		projectId: status.projectId,
		bindingId: status.bindingId,
		state: status.resource?.observedState ?? status.operation?.state ?? "unknown",
		provider: { label: status.provider.providerId },
		resource: status.resource,
		operation: status.operation,
	};
}
