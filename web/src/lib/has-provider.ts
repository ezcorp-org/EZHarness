import type { Settings } from "./api.js";

/**
 * Returns true if any LLM provider has a credential configured.
 *
 * Mirrors the server-side `hasAnyProvider()` predicate
 * (`src/db/queries/quickstart.ts`): a row keyed `provider:<name>:apiKey`
 * (BYOK) or `provider:oauth:<name>` (OAuth) means a provider is wired.
 *
 * Used by `QuickStartChecklist` and `NoProviderBanner` so client and
 * server agree on what "provider configured" means. If you change the
 * key conventions for provider credentials, update this function and
 * the SQL helper together.
 */
export function hasProviderInSettings(settings: Settings): boolean {
	return Object.keys(settings).some(
		(k) => (k.startsWith("provider:") && k.endsWith(":apiKey")) || k.startsWith("provider:oauth:"),
	);
}
