export type WorkspaceKind = "local" | "sandbox" | "incus" | "unavailable";

export type WorkspaceResolution = {
	kind: WorkspaceKind;
	canManage?: boolean;
	presetId?: string | null;
	observedState?: string;
	error?: string;
};

/** Resolves persisted workspace identity; an empty local path is not a binding. */
export async function resolveWorkspaceBinding(
	projectId: string,
	path: string,
	request: (input: string) => Promise<Response> = fetch,
): Promise<WorkspaceResolution> {
	try {
		const incus = await request(`/api/projects/${encodeURIComponent(projectId)}/incus-feature`);
		if (!incus.ok) {
			const body = await incus.json().catch(() => ({})) as { error?: string };
			return { kind: "unavailable", error: body.error ?? "Could not verify this workspace." };
		}
		const identity = await incus.json() as { kind?: unknown; canManage?: unknown; presetId?: unknown; observedState?: unknown };
		if (identity.kind === "incus" && typeof identity.canManage === "boolean"
			&& (identity.presetId === null || typeof identity.presetId === "string")
			&& typeof identity.observedState === "string") {
			return { kind: "incus", canManage: identity.canManage,
				presetId: identity.presetId, observedState: identity.observedState };
		}
		if (identity.kind !== "none") return { kind: "unavailable", error: "Could not verify this workspace." };
		if (path !== "") return { kind: "local" };
		const response = await request(`/api/projects/${encodeURIComponent(projectId)}/sandbox`);
		if (response.ok) return { kind: "sandbox" };
		const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
		if (body.code === "SANDBOX_NOT_CONFIGURED") return { kind: "local" };
		return { kind: "unavailable", error: body.error ?? "Could not verify this workspace." };
	} catch {
		return { kind: "unavailable", error: "Could not verify this workspace." };
	}
}
