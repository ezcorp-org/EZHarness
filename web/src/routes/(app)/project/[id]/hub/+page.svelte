<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import EmptyState from "$lib/components/EmptyState.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import { loadLastHubPage } from "$lib/hub-last-page";
	import type { HubPageListing } from "$lib/hub";

	// `/project/<id>/hub` is a redirect shell — the "open the Hub inside a
	// project" entry point. It loads the tab list and lands on, in order:
	//   (a) the page this project last remembered (if still listed),
	//   (b) else the first project-scoped tab (ez-code-factory's dashboard
	//       today), so an in-project open surfaces project context first,
	//   (c) else the first tab.
	// With zero pages it shows the same explainer as the global hub instead.
	let loading = $state(true);
	let error = $state("");

	onMount(() => {
		const projectId = page.params.id ?? "";
		// `cancelled` guards the post-fetch redirect: if the user navigates
		// away while the listing is in flight, a late goto() would yank them
		// back to the hub. Same guard as the global /hub shell — change both.
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch("/api/hub/pages");
				const data = res.ok ? ((await res.json()) as { pages: HubPageListing[] }) : null;
				if (cancelled) return;
				if (!data) throw new Error(`HTTP ${res.status}`);
				const pages = data.pages;

				const remembered = loadLastHubPage(projectId);
				const target =
					(remembered && pages.find((p) => p.id === remembered)) ??
					pages.find((p) => p.projectScoped) ??
					pages[0];

				if (target) {
					await goto(`/project/${projectId}/hub/${encodeURIComponent(target.id)}`, {
						replaceState: true,
					});
					return;
				}
				loading = false;
			} catch (e) {
				if (cancelled) return;
				error = e instanceof Error ? e.message : "Failed to load Hub";
				loading = false;
			}
		})();
		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:head>
	<title>Hub - EZCorp</title>
</svelte:head>

{#if loading}
	<SkeletonLoader type="lines" lines={4} />
{:else if error}
	<EmptyState title="Hub failed to load" description={error} />
{:else}
	<EmptyState
		title="No Hub pages yet"
		description="Extensions that declare pages — and core features like the Daily Briefing — show up here as tabs."
		ctaLabel="Browse extensions"
		ctaHref="/extensions"
	/>
{/if}
