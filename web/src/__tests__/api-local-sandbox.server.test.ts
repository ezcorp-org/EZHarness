import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const controller = {
	listLocalSandboxProviders: vi.fn(),
	createSandboxProject: vi.fn(),
	getProjectSandboxStatus: vi.fn(),
	requestSandboxAction: vi.fn(),
	executeAdmittedLocalSandboxOperation: vi.fn(),
	executeAdmittedLocalSandboxOperationRaw: vi.fn(),
};

vi.mock("$server/runtime/sandbox/controller", () => ({
	getSandboxController: () => controller,
	SandboxControllerError: class SandboxControllerError extends Error {
		constructor(public code: string, message: string) { super(message); }
	},
}));

const { GET: providers } = await import("../routes/api/sandboxes/providers/+server");
const { POST: create } = await import("../routes/api/sandboxes/+server");
const { GET: status, POST: action } = await import("../routes/api/projects/[id]/sandbox/+server");
const { POST: execute } = await import("../routes/api/local-sandbox/operations/[id]/execute/+server");
const { sandboxError, statusDto } = await import("../lib/server/sandbox-route");
const { SandboxControllerError } = await import("$server/runtime/sandbox/controller");

const user = { id: "user-1", email: "user@example.test", name: "User", role: "user" };
const local = { user };
const provider = { installationId: "11111111-1111-4111-8111-111111111111", providerId: "podman", releaseId: "release", releaseBinding: "binding", generation: 1 };
const sandboxStatus = { projectId: "sandbox", bindingId: "binding", provider, resource: { resourceId: "resource", observedState: "stopped", desiredState: "stopped", limits: {} }, operation: null };

const idempotencyKey = "22222222-2222-4222-8222-222222222222";
function event(path: string, options: { body?: unknown; locals?: Record<string, unknown>; params?: Record<string, string>; idempotent?: boolean } = {}) {
	return makeRequestEvent(`http://localhost${path}`, {
		locals: options.locals ?? local,
		params: options.params ?? {},
		request: { method: "POST", headers: { "content-type": "application/json", ...(options.idempotent === false ? {} : { "Idempotency-Key": idempotencyKey }) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) },
	});
}

beforeEach(() => {
	for (const fn of Object.values(controller)) fn.mockReset();
	controller.listLocalSandboxProviders.mockResolvedValue([provider]);
	controller.createSandboxProject.mockResolvedValue({ ...sandboxStatus, operation: { id: "create-operation", action: "create", state: "admitted" } });
	controller.getProjectSandboxStatus.mockResolvedValue(sandboxStatus);
	controller.requestSandboxAction.mockResolvedValue({ id: "operation", action: "start", state: "admitted", provider, input: { resourceId: "resource" } });
	controller.executeAdmittedLocalSandboxOperation.mockResolvedValue(sandboxStatus);
	controller.executeAdmittedLocalSandboxOperationRaw.mockResolvedValue({ id: "operation", state: "succeeded", receipt: { outcome: "succeeded" } });
});

describe("local sandbox API", () => {
	test("lists only controller-reviewed providers for the authenticated user", async () => {
		const response = await providers(event("/api/sandboxes/providers") as never);
		expect(await response.json()).toEqual({ providers: [{ installationId: provider.installationId, providerId: "podman", label: "podman", ready: true }] });
		expect(controller.listLocalSandboxProviders).toHaveBeenCalledWith("user-1");
	});

	test("maps provider listing failures through the shared sandbox error boundary", async () => {
		controller.listLocalSandboxProviders.mockRejectedValueOnce(new Error("provider unavailable"));
		const response = await providers(event("/api/sandboxes/providers") as never);
		expect(response.status).toBe(503);
	});

	test("maps controller error codes and status fallback without host details", async () => {
		expect(sandboxError(new SandboxControllerError("PROJECT_ACCESS_DENIED", "Denied")).status).toBe(403);
		expect(sandboxError(new SandboxControllerError("SANDBOX_CONTROLLER_UNAVAILABLE", "Unavailable")).status).toBe(503);
		const stale = sandboxError(new SandboxControllerError("STALE_WORKSPACE_BINDING", "Stale"));
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ code: "STALE_WORKSPACE_BINDING" });
		expect(statusDto({ ...sandboxStatus, resource: null, operation: { id: "pending", action: "start", state: "admitted" } }).state).toBe("admitted");
		expect(statusDto({ ...sandboxStatus, resource: null, operation: null }).state).toBe("unknown");
	});

	test("creates and executes a dedicated empty sandbox with host-owned limits", async () => {
		const response = await create(event("/api/sandboxes", { body: { name: "Sandbox", providerInstallationId: provider.installationId, providerId: "podman" } }) as never);
		expect(response.status).toBe(201);
		expect(controller.createSandboxProject).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "Sandbox", idempotencyKey, config: {}, limits: { memoryBytes: 512 * 1024 ** 2, milliCpu: 1000, pids: 64, diskBytes: 1024 ** 3 } }));
		expect(controller.executeAdmittedLocalSandboxOperation).toHaveBeenCalledWith("user-1", "create-operation");
		expect(controller.getProjectSandboxStatus).toHaveBeenCalledWith("user-1", "sandbox");
		expect(await response.json()).toMatchObject({ project: { id: "sandbox" } });
	});

	test("does not execute a creation that was not durably admitted", async () => {
		controller.createSandboxProject.mockResolvedValueOnce({ ...sandboxStatus, operation: null });
		const response = await create(event("/api/sandboxes", { body: { name: "Sandbox", providerInstallationId: provider.installationId, providerId: "podman" } }) as never);
		expect(response.status).toBe(409);
		expect(controller.executeAdmittedLocalSandboxOperation).not.toHaveBeenCalled();
	});

	test("executes a bounded lifecycle action through the reviewed controller path", async () => {
		const result = await action(event("/api/projects/sandbox/sandbox", { params: { id: "sandbox" }, body: { action: "start" } }) as never);
		expect(result.status).toBe(200);
		expect(controller.requestSandboxAction).toHaveBeenCalledWith("user-1", "sandbox", { action: "start", idempotencyKey });
		expect(controller.executeAdmittedLocalSandboxOperation).toHaveBeenCalledWith("user-1", "operation");
		expect(controller.getProjectSandboxStatus).toHaveBeenCalledWith("user-1", "sandbox");
	});

	test("requires an idempotency key before a lifecycle write reaches the controller", async () => {
		const response = await action(event("/api/projects/sandbox/sandbox", { params: { id: "sandbox" }, body: { action: "start" }, idempotent: false }) as never);
		expect(response.status).toBe(400);
		expect(controller.requestSandboxAction).not.toHaveBeenCalled();
	});

	test("denies browser and user API-key requests to the raw host callback", async () => {
		const response = await execute(event("/api/local-sandbox/operations/operation/execute", { params: { id: "operation" } }) as never);
		expect(response.status).toBe(403);
		expect(controller.executeAdmittedLocalSandboxOperationRaw).not.toHaveBeenCalled();
	});

	test("accepts raw dispatch only from the verified internal extension broker", async () => {
		const response = await execute(event("/api/local-sandbox/operations/operation/execute", {
			params: { id: "operation" },
			locals: { ...local, authMethod: "internal" },
		}) as never);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "operation", state: "succeeded" });
		expect(controller.executeAdmittedLocalSandboxOperationRaw).toHaveBeenCalledWith("user-1", "operation", expect.any(AbortSignal));
	});

	test("maps controller failures from each sandbox operation route", async () => {
		controller.createSandboxProject.mockRejectedValueOnce(new Error("provider unavailable"));
		const createResponse = await create(event("/api/sandboxes", { body: { name: "Sandbox", providerInstallationId: provider.installationId, providerId: "podman" } }) as never);
		expect(createResponse.status).toBe(503);

		controller.requestSandboxAction.mockRejectedValueOnce(new Error("provider unavailable"));
		const actionResponse = await action(event("/api/projects/sandbox/sandbox", { params: { id: "sandbox" }, body: { action: "start" } }) as never);
		expect(actionResponse.status).toBe(503);

		controller.executeAdmittedLocalSandboxOperationRaw.mockRejectedValueOnce(new Error("provider unavailable"));
		const rawResponse = await execute(event("/api/local-sandbox/operations/operation/execute", {
			params: { id: "operation" },
			locals: { ...local, authMethod: "internal" },
		}) as never);
		expect(rawResponse.status).toBe(503);
	});

	test("rejects arbitrary create fields and lifecycle arguments", async () => {
		const createResponse = await create(event("/api/sandboxes", { body: { name: "Sandbox", providerInstallationId: provider.installationId, providerId: "podman", path: "/host" } }) as never);
		expect(createResponse.status).toBe(400);
		expect(controller.createSandboxProject).not.toHaveBeenCalled();
		const actionResponse = await action(event("/api/projects/sandbox/sandbox", { params: { id: "sandbox" }, body: { action: "start", command: "whoami" } }) as never);
		expect(actionResponse.status).toBe(400);
		expect(controller.requestSandboxAction).not.toHaveBeenCalled();
	});

	test("maps controller status without exposing host paths", async () => {
		const response = await status(event("/api/projects/sandbox/sandbox", { params: { id: "sandbox" } }) as never);
		expect(await response.json()).toMatchObject({ projectId: "sandbox", state: "stopped", provider: { label: "podman" } });
	});

	test("maps sandbox status lookup failures", async () => {
		controller.getProjectSandboxStatus.mockRejectedValueOnce(new Error("provider unavailable"));
		const response = await status(event("/api/projects/sandbox/sandbox", { params: { id: "sandbox" } }) as never);
		expect(response.status).toBe(503);
	});
});
