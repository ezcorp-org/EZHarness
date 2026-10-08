import { describe, expect, test, vi } from "vitest";
import { resolveWorkspaceBinding } from "../workspace-binding";

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("resolveWorkspaceBinding", () => {
	test("keeps a non-empty path local without a sandbox request", async () => {
		const request = vi.fn().mockResolvedValue(response({ kind: "none" }));
		await expect(resolveWorkspaceBinding("project", "/repo", request)).resolves.toEqual({ kind: "local" });
		expect(request).toHaveBeenCalledWith("/api/projects/project/incus-feature");
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("uses a persisted status response to identify a sandbox", async () => {
		const request = vi.fn().mockResolvedValueOnce(response({ kind: "none" })).mockResolvedValueOnce(response({ state: "stopped" }));
		await expect(resolveWorkspaceBinding("sandbox id", "", request)).resolves.toEqual({ kind: "sandbox" });
		expect(request).toHaveBeenCalledWith("/api/projects/sandbox%20id/sandbox");
	});

	test("keeps an empty path local only for the explicit no-binding response", async () => {
		await expect(resolveWorkspaceBinding("project", "", vi.fn().mockResolvedValueOnce(response({ kind: "none" })).mockResolvedValueOnce(response({ code: "SANDBOX_NOT_CONFIGURED" }, 409)))).resolves.toEqual({ kind: "local" });
	});

	test("fails closed for service errors and transport failures", async () => {
		await expect(resolveWorkspaceBinding("project", "", vi.fn().mockResolvedValue(response({ error: "Unavailable" }, 503)))).resolves.toEqual({ kind: "unavailable", error: "Unavailable" });
		await expect(resolveWorkspaceBinding("project", "", vi.fn().mockRejectedValue(new Error("offline")))).resolves.toEqual({ kind: "unavailable", error: "Could not verify this workspace." });
	});

	test("uses the saved Incus binding even when the project path looks ordinary", async () => {
		const request = vi.fn().mockResolvedValue(response({ kind: "incus", canManage: true, presetId: "incus-compose-v1", observedState: "STOPPED" }));
		await expect(resolveWorkspaceBinding("project", "/repo", request)).resolves.toEqual({ kind: "incus", canManage: true, presetId: "incus-compose-v1", observedState: "STOPPED" });
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("does not make the admin link available to a member", async () => {
		const request = vi.fn().mockResolvedValue(response({ kind: "incus", canManage: false, presetId: "incus-compose-v1", observedState: "RUNNING" }));
		await expect(resolveWorkspaceBinding("project", "/repo", request)).resolves.toEqual({ kind: "incus", canManage: false, presetId: "incus-compose-v1", observedState: "RUNNING" });
	});

	test("fails closed for an unavailable provider connection or malformed identity", async () => {
		await expect(resolveWorkspaceBinding("project", "/repo", vi.fn().mockResolvedValue(response({ kind: "unavailable" })))).resolves.toEqual({ kind: "unavailable", error: "Could not verify this workspace." });
		await expect(resolveWorkspaceBinding("project", "/repo", vi.fn().mockResolvedValue(response({ kind: "incus", canManage: true })))).resolves.toEqual({ kind: "unavailable", error: "Could not verify this workspace." });
	});
});
