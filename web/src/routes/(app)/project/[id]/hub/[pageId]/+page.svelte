<!--
  Project-scoped hub deep-link. Thin wrapper over the shared HubPageView;
  tab links stay under `/project/[id]/hub/...` so navigation keeps the
  active-project context. Entered from the extension detail page's "Hub
  Pages" cards. The project id rides every render pull (`?project=`), so
  pages declared `perProject: true` render THIS project's view; pages
  without the flag ignore it and stay global.
-->
<script lang="ts">
	import { page } from "$app/state";
	import HubPageView from "$lib/components/hub/HubPageView.svelte";

	let pageId = $derived(page.params.pageId ?? "");
	let hubBase = $derived(`/project/${page.params.id}/hub`);
	let projectId = $derived(page.params.id ?? "");
</script>

<HubPageView {pageId} {hubBase} {projectId} />
