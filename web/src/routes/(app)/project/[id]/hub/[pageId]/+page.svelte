<!--
  Project-scoped hub deep-link. Thin wrapper over the shared HubPageView;
  tab links stay under `/project/[id]/hub/...` so navigation keeps the
  active-project context. Entered from the extension detail page's "Hub
  Pages" cards. Hub page content itself is global (the `/api/hub/...`
  calls inside HubPageView are not project-scoped).
-->
<script lang="ts">
	import { page } from "$app/state";
	import HubPageView from "$lib/components/hub/HubPageView.svelte";

	let pageId = $derived(page.params.pageId ?? "");
	let hubBase = $derived(`/project/${page.params.id}/hub`);
</script>

<HubPageView {pageId} {hubBase} />
