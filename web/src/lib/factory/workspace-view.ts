/** The factory workspace views, and the one the URL may name. */
export type FactoryWorkspaceView = "authoring" | "runs" | "inbox" | "admin";
export const FACTORY_WORKSPACE_VIEWS: readonly FactoryWorkspaceView[] = ["authoring", "runs", "inbox", "admin"];

/** The view named in the URL, or authoring. An unknown value is never trusted as a view. */
export function factoryWorkspaceView(value: string | null): FactoryWorkspaceView {
	return FACTORY_WORKSPACE_VIEWS.find(view => view === value) ?? "authoring";
}
