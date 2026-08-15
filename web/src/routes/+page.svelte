<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import {
		resolveResumeTarget,
		consumeResumePath,
		ACTIVE_PROJECT_KEY,
		GLOBAL_PROJECT_ID,
	} from "$lib/resume-path.js";

	// Resume-on-open: send the user straight back to where they left off in a
	// SINGLE navigation (mobile + desktop), instead of bouncing through the
	// chat list. Pure decision logic lives in `$lib/resume-path`.
	onMount(() => {
		// `cancelled` guards the post-fetch redirect: if the user navigates
		// away while the projects list is in flight, a late goto() would yank
		// them back to this resume shell. Same guard as the hub redirect
		// shells (src/routes/(app)/hub + project/[id]/hub) — change together.
		let cancelled = false;
		void (async () => {
			const ls = typeof localStorage !== "undefined" ? localStorage : null;
			// CONSUMED, not read: a target that bounces back to `/` must not be
			// re-resolved on the way back in, or `/` and that route ping-pong
			// forever. See `consumeResumePath`. The `(app)` layout re-records the
			// path as soon as the target actually renders, so a normal open is
			// unchanged.
			const lastPath = consumeResumePath(ls);
			const savedProjectId = ls?.getItem(ACTIVE_PROJECT_KEY) ?? null;

			// One fetch to learn which projects still exist — drives both the
			// last-path validation and the project fallback. A network failure
			// leaves the list empty, so the resolver falls back to the global
			// workspace (never a dead route).
			let validProjectIds: string[] = [];
			let fetched = false;
			try {
				const r = await fetch("/api/projects");
				if (r.ok) {
					const projects: Array<{ id: string }> = await r.json();
					validProjectIds = projects.map((p) => p.id);
					fetched = true;
				}
			} catch {
				// fall through to the global workspace
			}

			if (cancelled) return;

			// Drop a confirmed-stale activeProjectId so we stop re-validating it.
			if (
				ls &&
				fetched &&
				savedProjectId &&
				savedProjectId !== GLOBAL_PROJECT_ID &&
				!validProjectIds.includes(savedProjectId)
			) {
				ls.removeItem(ACTIVE_PROJECT_KEY);
			}

			goto(resolveResumeTarget({ lastPath, savedProjectId, validProjectIds }), {
				replaceState: true,
			});
		})();
		return () => {
			cancelled = true;
		};
	});
</script>
