<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { refreshProjects, setActiveProjectId } from "$lib/stores.svelte.js";
	import { createDir, createProject } from "$lib/api.js";
	import ProjectForm from "$lib/components/ProjectForm.svelte";
	import ProjectPrefillBanner from "$lib/components/ez/ProjectPrefillBanner.svelte";
	import { getDraft, consumeDraft } from "$lib/ez/api.js";

	let submitting = $state(false);
	let prefillData = $state<{ name?: string; path?: string } | null>(null);
	/** Bumped after each prefill hydration so the form remounts with the new `initial`. */
	let prefillKey = $state(0);
	let bannerState = $state<"hidden" | "active" | "expired">("hidden");
	let consumedDraftId = $state<string | null>(null);

	// Hydrate from `?prefill=<draftId>` once. Re-running on prefillId change
	// covers the case where Ez navigates the user here from another page.
	let lastFetchedPrefill = "";
	$effect(() => {
		const id = page.url.searchParams.get("prefill");
		if (!id || id === lastFetchedPrefill) return;
		lastFetchedPrefill = id;
		consumedDraftId = id;
		void hydrateFromDraft(id);
	});

	async function hydrateFromDraft(id: string) {
		try {
			const draft = await getDraft(id);
			if (!draft || draft.consumed || isExpired(draft.expiresAt)) {
				bannerState = "expired";
				return;
			}
			const payload = draft.payload ?? {};
			prefillData = {
				name: typeof payload.name === "string" ? payload.name : undefined,
				path: typeof payload.path === "string" ? payload.path : undefined,
			};
			prefillKey++;
			bannerState = "active";
		} catch {
			// 404/expired/cross-user → expired banner.
			bannerState = "expired";
		}
	}

	function isExpired(expiresAt: string | Date | null | undefined): boolean {
		if (!expiresAt) return false;
		const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : new Date(expiresAt).getTime();
		return Number.isFinite(t) && t < Date.now();
	}

	function dismissBanner() { bannerState = "hidden"; }

	async function handleCreate(data: { name: string; path: string; variables: Record<string, unknown> }) {
		submitting = true;
		try {
			// mkdir -p is idempotent, so this is a no-op if the folder already exists.
			await createDir(data.path);
			const project = await createProject(data);
			// Mark the draft consumed so a refresh shows the "expired" banner
			// rather than re-hydrating the same form. Best-effort — failure
			// here must not block the flow.
			if (consumedDraftId) {
				try { await consumeDraft(consumedDraftId); } catch { /* swallow */ }
			}
			refreshProjects();
			setActiveProjectId(project.id);
			goto(`/project/${project.id}/chat`);
		} finally {
			submitting = false;
		}
	}

</script>

<div class="space-y-6">
	<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">Create Project</h2>

	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		{#if bannerState === "active"}
			<ProjectPrefillBanner state="active" ondismiss={dismissBanner} />
		{:else if bannerState === "expired"}
			<ProjectPrefillBanner state="expired" ondismiss={dismissBanner} />
		{/if}

		{#key prefillKey}
			<ProjectForm initial={prefillData ?? undefined} onsubmit={handleCreate} {submitting} />
		{/key}
	</div>
</div>
