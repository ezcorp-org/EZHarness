<script lang="ts">
	// Stands in for the factory workspace in page tests: renders the props it
	// received so a test can read what the page passed, and offers the page's
	// callbacks as buttons.
	let {
		projectId,
		projects,
		view,
		tenantId,
		administrator,
		currentUserId,
		runId,
		onProjectChange,
		onViewChange,
		onOpenRun,
	}: {
		projectId: string;
		projects?: { id: string }[];
		view?: string;
		tenantId?: string | null;
		administrator?: boolean;
		currentUserId?: string | null;
		runId?: string | null;
		onProjectChange?: (id: string) => void;
		onViewChange?: (view: string) => void;
		onOpenRun?: (runId: string) => void;
	} = $props();
</script>

<div
	data-testid="factory-props-probe"
	data-project-id={projectId}
	data-projects={projects ? projects.map(project => project.id).join(",") : "none"}
	data-view={view ?? "none"}
	data-tenant-id={tenantId ?? "none"}
	data-administrator={administrator === undefined ? "none" : String(administrator)}
	data-current-user-id={currentUserId ?? "none"}
	data-run-id={runId ?? "none"}
>
	{#if onProjectChange}
		<button type="button" onclick={() => onProjectChange("project-b")}>choose project-b</button>
	{/if}
	{#if onViewChange}
		<button type="button" onclick={() => onViewChange("runs")}>view runs</button>
		<button type="button" onclick={() => onViewChange("authoring")}>view authoring</button>
	{/if}
	{#if onOpenRun}
		<button type="button" onclick={() => onOpenRun("run/1")}>open run/1</button>
	{/if}
</div>
