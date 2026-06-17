<script lang="ts">
	/**
	 * Recording stub for `SearchDefaultsSection.svelte` used by
	 * page.component.test.ts. The real section auto-saves via fetch on
	 * change — irrelevant here, where the assertion is "the page resolved
	 * these `defaults` and mounted me with them".
	 *
	 * Mirrors the data-attribute-recorder pattern (LessonsTabStub):
	 * forward the resolved `defaults` as `data-*` attrs so the test reads
	 * them back via `getByTestId(...).getAttribute(...)`.
	 */
	import type { SearchDefaultsForm } from "$lib/settings-search-config.js";
	let { defaults }: { defaults: SearchDefaultsForm } = $props();
</script>

<div
	data-testid="search-defaults-stub"
	data-allowed={String(defaults.allowedByDefault)}
	data-quota={String(defaults.quota)}
	data-maxresults={String(defaults.maxResults)}
	data-providers={defaults.providers}
></div>
