<!--
  Global "home" hub deep-link. Thin wrapper over the shared HubPageView;
  tab links stay under `/hub/...`. The project-scoped twin lives at
  `/project/[id]/hub/[pageId]` and reuses the SAME component.
-->
<script lang="ts">
	import { page } from "$app/state";
	import HubPageView from "$lib/components/hub/HubPageView.svelte";

	let pageId = $derived(page.params.pageId ?? "");
</script>

<HubPageView {pageId} hubBase="/hub" />
