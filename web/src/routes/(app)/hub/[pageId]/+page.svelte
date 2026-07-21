<!--
  Global "home" hub deep-link. Thin wrapper over the shared HubPageView;
  tab links stay under `/hub/...`. The project-scoped twin lives at
  `/project/[id]/hub/[pageId]` and reuses the SAME component.
-->
<script lang="ts">
	import { page } from "$app/state";
	import HubPageView from "$lib/components/hub/HubPageView.svelte";

	let pageId = $derived(page.params.pageId ?? "");
	// `?run=<id>` opens a run-detail render variant; `?step=<name>` (a
	// sub-variant of `?run=`) opens one step's detail within that run.
	let run = $derived(page.url.searchParams.get("run") ?? undefined);
	let step = $derived(page.url.searchParams.get("step") ?? undefined);
</script>

<HubPageView {pageId} hubBase="/hub" {run} {step} />
