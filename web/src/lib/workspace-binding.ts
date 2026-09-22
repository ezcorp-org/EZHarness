export type WorkspaceKind = "local" | "sandbox" | "unavailable";

export type WorkspaceResolution = {
	kind: WorkspaceKind;
	error?: string;
};

/** Resolves persisted workspace identity; an empty local path is not a binding. */
export async function resolveWorkspaceBinding(
	projectId: string,
	path: string,
	request: (input: string) => Promise<Response> = fetch,
): Promise<WorkspaceResolution> {
	if (path !== "") return { kind: "local" };
	try {
		const response = await request(`/api/projects/${encodeURIComponent(projectId)}/sandbox`);
		if (response.ok) return { kind: "sandbox" };
		const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
		if (body.code === "SANDBOX_NOT_CONFIGURED") return { kind: "local" };
		return { kind: "unavailable", error: body.error ?? "Could not verify this workspace." };
	} catch {
		return { kind: "unavailable", error: "Could not verify this workspace." };
	}
}
