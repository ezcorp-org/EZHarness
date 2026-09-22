<script lang="ts">
	import { goto } from "$app/navigation";
	import { refreshProjects } from "$lib/stores.svelte.js";

	type Provider = { installationId: string; providerId: string; label: string; ready: boolean; reason?: string };
	type Repository = { id: number; fullName: string; defaultBranch: string; private: boolean; accessStatus: "ready" | "insufficient_user_permission" };
	type Connection = { status: "disconnected" | "connected" | "reconnect_required"; configured: boolean };

	let { projectId, providers = [], pendingPrivate = false, onimported }: {
		projectId: string;
		providers?: Provider[];
		pendingPrivate?: boolean;
		onimported?: () => void;
	} = $props();

	let connection = $state<Connection | null>(null);
	let repositories = $state<Repository[]>([]);
	let repositoryId = $state(0);
	let providerId = $state("");
	let busy = $state(false);
	let error = $state("");
	let newProjectId = $state<string | null>(null);
	let createKey = $state<string | null>(null);
	let createSubmitted = $state(false);
	let importKey = $state<string | null>(null);
	let importSubmitted = $state(false);
	let loaded = $state(false);

	$effect(() => {
		const controller = new AbortController();
		fetch("/api/github/connection", { signal: controller.signal }).then(async (account) => {
			if (!account.ok) throw new Error("Could not load GitHub connection");
			const accountData = await account.json() as Connection;
			let listData: { repositories: Repository[] } = { repositories: [] };
			if (accountData.status === "connected") {
				const list = await fetch("/api/github/repositories", { signal: controller.signal });
				if (!list.ok) throw new Error("Could not load GitHub repositories");
				listData = await list.json() as { repositories: Repository[] };
			}
			if (controller.signal.aborted) return;
			connection = accountData;
			repositories = listData.repositories ?? [];
			loaded = true;
		}).catch(() => { if (!controller.signal.aborted) { error = "Could not load GitHub repositories"; loaded = true; } });
		return () => controller.abort();
	});

	let selectedRepository = $derived(repositories.find((repository) => repository.id === repositoryId));
	let selectedProvider = $derived(providers.find((provider) => provider.installationId === providerId));

	async function importRepository() {
		if (!selectedRepository || selectedRepository.accessStatus !== "ready" || busy) return;
		if (!pendingPrivate && !selectedProvider?.ready) return;
		busy = true;
		error = "";
		try {
			let targetId = pendingPrivate ? projectId : newProjectId;
			if (!targetId) {
				createKey ??= crypto.randomUUID();
				createSubmitted = true;
				const createResponse = await fetch("/api/github/sandboxes", {
					method: "POST",
					headers: { "content-type": "application/json", "Idempotency-Key": createKey },
					body: JSON.stringify({ name: `Sandbox for ${selectedRepository.fullName}`, providerInstallationId: selectedProvider!.installationId, providerId: selectedProvider!.providerId }),
				});
				const created = await createResponse.json();
				if (!createResponse.ok) throw new Error(created.error ?? "Could not create private sandbox");
				targetId = created.project.id as string;
				newProjectId = targetId;
			}
			importKey ??= crypto.randomUUID();
			importSubmitted = true;
			const importResponse = await fetch(`/api/github/personal-prs/sandboxes/${encodeURIComponent(targetId)}/import`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ repositoryId: selectedRepository.id, baseRef: selectedRepository.defaultBranch, idempotencyKey: importKey }),
			});
			const imported = await importResponse.json();
			if (!importResponse.ok) throw new Error(imported.error ?? "Could not import repository");
			if (pendingPrivate) onimported?.();
			if (!await refreshProjects()) throw new Error("Could not load the private sandbox");
			await goto(`/project/${targetId}/settings`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not import repository";
		} finally { busy = false; }
	}
</script>

<section class="mt-5 border-t border-[var(--color-border)] pt-5" data-testid="github-sandbox-import">
	<h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Import from GitHub</h4>
	<p class="mt-1 text-sm text-[var(--color-text-secondary)]">Choose a repository. EZCorp imports it on the host into a sandbox only you can use.</p>
	{#if error}<p class="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>{/if}
	{#if !loaded}<p class="mt-3 text-sm text-[var(--color-text-muted)]" role="status">Checking GitHub access…</p>
	{:else if !connection?.configured}<p class="mt-3 text-sm text-[var(--color-text-secondary)]">GitHub connection is not configured on this server.</p>
	{:else if connection.status !== "connected"}
		<a class="mt-3 inline-block text-sm text-[var(--color-accent)] underline" href="/settings/github">{connection.status === "reconnect_required" ? "Reconnect GitHub" : "Connect GitHub"}</a>
	{:else}
		{#if repositories.length}
			<div class="mt-3 grid gap-3 sm:grid-cols-2">
				<div><label for="github-import-repository" class="block text-xs font-medium text-[var(--color-text-secondary)]">Repository</label><select id="github-import-repository" bind:value={repositoryId} disabled={busy || createSubmitted || importSubmitted || !!newProjectId} class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"><option value={0}>Select a repository</option>{#each repositories as repository}<option value={repository.id}>{repository.fullName}{repository.accessStatus === "ready" ? "" : " · no write access"}</option>{/each}</select></div>
				{#if !pendingPrivate}<div><label for="github-import-provider" class="block text-xs font-medium text-[var(--color-text-secondary)]">Sandbox provider</label><select id="github-import-provider" bind:value={providerId} disabled={busy || createSubmitted || !!newProjectId} class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"><option value="">Select a provider</option>{#each providers as provider}<option value={provider.installationId} disabled={!provider.ready}>{provider.label}</option>{/each}</select></div>{/if}
			</div>
			{#if selectedRepository?.accessStatus === "insufficient_user_permission"}<p class="mt-2 text-sm text-amber-700 dark:text-amber-300" role="status">Your GitHub account needs write access to this repository.</p>{/if}
			<button class="mt-3 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy || selectedRepository?.accessStatus !== "ready" || !pendingPrivate && !selectedProvider?.ready} onclick={importRepository}>{busy ? "Importing repository…" : pendingPrivate ? "Import into this sandbox" : "Create private sandbox & import"}</button>
		{:else}<p class="mt-3 text-sm text-[var(--color-text-secondary)]">No enabled repositories are available. Enable a repository or request organization approval on GitHub.</p>{/if}
		<a class="mt-3 block text-xs text-[var(--color-accent)] underline" href="/settings/github">Manage GitHub connection</a>
	{/if}
	{#if newProjectId && error}<a class="mt-3 block text-sm text-[var(--color-accent)] underline" href={`/project/${newProjectId}/settings`}>Open the private sandbox</a>{/if}
</section>
