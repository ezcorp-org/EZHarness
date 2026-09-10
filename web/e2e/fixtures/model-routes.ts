/**
 * Complete route overrides for a chat model catalog.
 *
 * `setupApiMocks` matches custom route keys with `path.includes()`. A bare
 * `/api/models` override therefore also catches the capabilities and default
 * selection endpoints. Keep their response contracts here so chat fixtures
 * never replace a capability row with a model array.
 */
export type MockModel = {
	provider: string;
	model: string;
	displayName: string;
	available: boolean;
	[key: string]: unknown;
};

export function modelCatalogRoutes(models: readonly MockModel[]) {
	const selected = models[0];
	if (!selected) throw new Error("A chat model route needs at least one available model.");

	return {
		"/api/models/capabilities": () => ({
			provider: selected.provider,
			model: selected.model,
			kinds: ["text"],
			acceptedMimeTypes: [],
			maxBytesPerFile: 0,
			maxFilesPerMessage: 0,
		}),
		"/api/models/default-selection": () => ({ value: "first" }),
		"/api/models": () => models,
	};
}
