<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";

	onMount(async () => {
		const saved =
			typeof localStorage !== "undefined" ? localStorage.getItem("activeProjectId") : null;
		let target = "global";
		if (saved && saved !== "global") {
			try {
				const r = await fetch("/api/projects");
				if (r.ok) {
					const projects: Array<{ id: string }> = await r.json();
					if (projects.some((p) => p.id === saved)) {
						target = saved;
					} else if (typeof localStorage !== "undefined") {
						localStorage.removeItem("activeProjectId");
					}
				}
			} catch {
				// fall through to global
			}
		}
		goto(`/project/${target}/chat`, { replaceState: true });
	});
</script>
