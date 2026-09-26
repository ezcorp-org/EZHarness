<script lang="ts">
	// Stands in for a factory page child in page tests: renders the props it
	// received so a test can read what the page passed, and offers the page's
	// project-change callback as a button.
	let {
		projectId,
		projects,
		onProjectChange,
	}: {
		projectId: string;
		projects?: { id: string }[];
		onProjectChange?: (id: string) => void;
	} = $props();
</script>

<div data-testid="factory-props-probe" data-project-id={projectId} data-projects={projects ? projects.map(project => project.id).join(",") : "none"}>
	{#if onProjectChange}
		<button type="button" onclick={() => onProjectChange("project-b")}>choose project-b</button>
	{/if}
</div>
