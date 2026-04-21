<script lang="ts">
	import { goto } from "$app/navigation";
	import { refreshProjects, setActiveProjectId } from "$lib/stores.svelte.js";
	import { createDir, createProject } from "$lib/api.js";
	import ProjectForm from "$lib/components/ProjectForm.svelte";

	let submitting = $state(false);

	async function handleCreate(data: { name: string; path: string; variables: Record<string, unknown> }) {
		submitting = true;
		try {
			// mkdir -p is idempotent, so this is a no-op if the folder already exists.
			await createDir(data.path);
			const project = await createProject(data);
			refreshProjects();
			setActiveProjectId(project.id);
			goto(`/project/${project.id}`);
		} finally {
			submitting = false;
		}
	}
</script>

<div class="space-y-6">
	<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">Create Project</h2>

	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<ProjectForm onsubmit={handleCreate} {submitting} />
	</div>
</div>
