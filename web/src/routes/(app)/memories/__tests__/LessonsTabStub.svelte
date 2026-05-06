<script lang="ts">
	/**
	 * Recording stub for `LessonsTab.svelte` used by page.component.test.ts.
	 * Real LessonsTab does fetch + state, none of which is relevant when
	 * the assertion is "the parent page mounted me with this `projectId`".
	 *
	 * Mirrors the data-attribute-recorder pattern used by
	 * `StubLucideIcon.svelte`: forward the prop as a `data-*` attribute
	 * so the test reads it back via `getByTestId(...).getAttribute(...)`.
	 */
	let { projectId }: { projectId: string } = $props();
</script>

<div data-testid="lessons-tab-stub" data-project-id={projectId}></div>
