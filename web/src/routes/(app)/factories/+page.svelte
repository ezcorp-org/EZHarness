<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import FactoryWorkspace from "$lib/factory/FactoryWorkspace.svelte";
	import { factoryWorkspaceView, type FactoryWorkspaceView } from "$lib/factory/workspace-view";
	import { setActiveProjectId, store } from "$lib/stores.svelte.js";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	let projects = $derived(store.projects.filter(project => project.id !== "global"));
	let projectId = $derived(projects.some(project => project.id === store.activeProjectId) ? store.activeProjectId : (projects[0]?.id ?? ""));
	let view = $derived(factoryWorkspaceView(page.url.searchParams.get("view")));
	// The server's answer paints first; the session's own record confirms it,
	// as the app layout does. It only enables controls; the server re-checks every action.
	let confirmed = $state<boolean | null>(null);
	let currentUserId = $state<string | null>(null);
	let runId = $derived(page.url.searchParams.get("run"));
	let administrator = $derived(confirmed ?? data.administrator);

	onMount(() => {
		fetch("/api/auth/me")
			.then(response => (response.ok ? response.json() : null))
			.then((me: { user?: { id?: string; role?: string } } | null) => {
				if (!me?.user) return;
				confirmed = me.user.role === "admin";
				currentUserId = me.user.id ?? null;
			})
			.catch(() => undefined);
	});

	function changeView(next: FactoryWorkspaceView, run?: string): void {
		const url = new URL(page.url);
		if (next === "authoring") url.searchParams.delete("view");
		else url.searchParams.set("view", next);
		if (run) url.searchParams.set("run", run);
		else url.searchParams.delete("run");
		void goto(url, { keepFocus: true, noScroll: true, replaceState: false });
	}
</script>

<svelte:head>
	<title>Factories — EZHarness</title>
</svelte:head>

<FactoryWorkspace {projects} {projectId} onProjectChange={setActiveProjectId} {view} onViewChange={next => changeView(next)} tenantId={data.tenantId} {administrator} {currentUserId} {runId} onOpenRun={run => changeView("runs", run)} />
