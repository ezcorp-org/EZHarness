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
	// `?run=<id>` opens a run-detail render variant; `?step=<name>` (a
	// sub-variant of `?run=`) opens one step's detail within that run.
	let run = $derived(page.url.searchParams.get("run") ?? undefined);
	let step = $derived(page.url.searchParams.get("step") ?? undefined);
	// `?view=<value>` opens an alternate page surface (config / job / audit) —
	// independent of `?run=`.
	let view = $derived(page.url.searchParams.get("view") ?? undefined);
</script>

<HubPageView {pageId} {hubBase} {projectId} {run} {step} {view} />
