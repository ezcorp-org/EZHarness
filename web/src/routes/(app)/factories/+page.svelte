<script lang="ts">
	import FactoryConsole from "$lib/factory/FactoryConsole.svelte";
	import { setActiveProjectId, store } from "$lib/stores.svelte.js";

	let projects = $derived(store.projects.filter(project => project.id !== "global"));
	let projectId = $derived(projects.some(project => project.id === store.activeProjectId) ? store.activeProjectId : (projects[0]?.id ?? ""));
</script>

<svelte:head>
	<title>Factories — EZHarness</title>
</svelte:head>

<FactoryConsole {projects} {projectId} onProjectChange={setActiveProjectId} />
