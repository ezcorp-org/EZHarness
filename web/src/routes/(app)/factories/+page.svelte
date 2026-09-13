<script lang="ts">
	import FactoryConsole from "$lib/factory/FactoryConsole.svelte";
	import FactoryReleaseInbox from "$lib/factory/FactoryReleaseInbox.svelte";
	import { setActiveProjectId, store } from "$lib/stores.svelte.js";

	let projects = $derived(store.projects.filter(project => project.id !== "global"));
	let projectId = $derived(projects.some(project => project.id === store.activeProjectId) ? store.activeProjectId : (projects[0]?.id ?? ""));
</script>

<svelte:head>
	<title>Factories — EZHarness</title>
</svelte:head>

<FactoryReleaseInbox {projectId} />
<FactoryConsole {projects} {projectId} onProjectChange={setActiveProjectId} />
