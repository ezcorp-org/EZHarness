<script lang="ts">
	import { goto } from "$app/navigation";
	import { refreshProjects } from "$lib/stores.svelte.js";
	import { trustedGithubUrl } from "$lib/personal-pr.js";

	type Provider = { installationId: string; providerId: string; label: string; ready: boolean; reason?: string };
	type Repository = { id: number; fullName: string; defaultBranch: string; private: boolean; accessStatus: "ready" | "insufficient_user_permission" };
	type Connection = { status: "disconnected" | "connected" | "reconnect_required"; configured: boolean; installUrl?: string };
	type IncusEnvironment = { installationId: string; connectionId: string; presetId: string; label: string; qualified: boolean };
	type IncusRequest = { kind: "incus"; name: string; installationId: string; connectionId: string; presetId: string; repositoryId: number; baseRef: string };

	let { projectId, providers = [], pendingPrivate = false, onimported }: {
		projectId: string;
		providers?: Provider[];
		pendingPrivate?: boolean;
		onimported?: () => void;
	} = $props();

	let connection = $state<Connection | null>(null);
	let repositories = $state<Repository[]>([]);
	let repositoryId = $state(0);
	let baseRef = $state("");
	let providerId = $state("");
	let busy = $state(false);
	let error = $state("");
	let newProjectId = $state<string | null>(null);
	let createKey = $state<string | null>(null);
	let createSubmitted = $state(false);
	let importKey = $state<string | null>(null);
	let importSubmitted = $state(false);
	let loaded = $state(false);
	let incusEnvironments = $state<IncusEnvironment[]>([]);
	let incusNotice = $state("");
	let incusRequest = $state<IncusRequest | null>(null);
	let incusUnknown = $state(false);
	let incusPartial = $state(false);
	const environmentKey = (environment: IncusEnvironment) => `incus:${environment.installationId}:${environment.connectionId}:${environment.presetId}`;
	const privateSandboxName = (fullName: string) => `Sandbox for ${fullName}`.slice(0, 120);

	$effect(() => {
		if (pendingPrivate || connection?.status !== "connected") return;
		const controller = new AbortController();
		fetch("/api/infrastructure/incus/management", { signal: controller.signal }).then(async (result) => {
			if (result.status === 403) return;
			if (!result.ok) throw new Error("Could not load Incus environments");
			const data = await result.json() as { environments?: IncusEnvironment[]; truncated?: boolean };
			if (!controller.signal.aborted) {
				incusEnvironments = (data.environments ?? []).filter((environment) => environment.qualified === true);
				if (data.truncated) incusNotice = "More environments are available in Incus management.";
			}
		}).catch(() => { if (!controller.signal.aborted) incusNotice = "Incus environments could not be loaded. Check Incus management and reopen this form."; });
		return () => controller.abort();
	});

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
	$effect(() => { baseRef = selectedRepository?.defaultBranch ?? ""; });
	let validBaseRef = $derived(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(baseRef) && !baseRef.includes("..") && !baseRef.includes("//") && !baseRef.endsWith("/") && !baseRef.endsWith(".lock"));
	let selectedProvider = $derived(providers.find((provider) => provider.installationId === providerId));
	let selectedIncus = $derived(incusEnvironments.find((environment) => environmentKey(environment) === providerId));

	async function importRepository() {
		if (incusPartial) return;
		if (!selectedRepository || selectedRepository.accessStatus !== "ready" || !validBaseRef || busy) return;
		if (!pendingPrivate && !selectedProvider?.ready && !selectedIncus && !incusRequest) return;
		busy = true;
		error = "";
		try {
			if (!pendingPrivate && (selectedIncus || incusRequest)) {
				if (!incusRequest && selectedIncus) incusRequest = {
					kind: "incus", name: privateSandboxName(selectedRepository.fullName),
					installationId: selectedIncus.installationId, connectionId: selectedIncus.connectionId,
					presetId: selectedIncus.presetId, repositoryId: selectedRepository.id, baseRef,
				};
				createKey ??= crypto.randomUUID();
				createSubmitted = true;
				const result = await fetch("/api/github/sandboxes", {
					method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": createKey },
					body: JSON.stringify(incusRequest),
				});
				const created = await result.json();
				if (created.code === "incus_import_partial") incusPartial = true;
				if (!result.ok) throw new Error(created.error ?? "Could not import source into a new Incus workspace");
				newProjectId = created.project.id as string;
				if (created.import?.importState !== "ready") { incusUnknown = true; return; }
				incusUnknown = false;
				if (!await refreshProjects()) throw new Error("Could not load the private sandbox");
				await goto(`/project/${newProjectId}`);
				return;
			}
			let targetId = pendingPrivate ? projectId : newProjectId;
			if (!targetId) {
				createKey ??= crypto.randomUUID();
				createSubmitted = true;
				const createResponse = await fetch("/api/github/sandboxes", {
					method: "POST",
					headers: { "content-type": "application/json", "Idempotency-Key": createKey },
					body: JSON.stringify({ name: privateSandboxName(selectedRepository.fullName), providerInstallationId: selectedProvider!.installationId, providerId: selectedProvider!.providerId }),
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
				body: JSON.stringify({ repositoryId: selectedRepository.id, baseRef, idempotencyKey: importKey }),
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
					<div><label for="github-import-base" class="block text-xs font-medium text-[var(--color-text-secondary)]">Base branch</label><input id="github-import-base" type="text" bind:value={baseRef} disabled={busy || createSubmitted || importSubmitted || !!newProjectId || !selectedRepository} maxlength="200" placeholder="Select a repository first" aria-invalid={!!baseRef && !validBaseRef} class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></div>
				{#if !pendingPrivate}<div><label for="github-import-provider" class="block text-xs font-medium text-[var(--color-text-secondary)]">Sandbox provider</label><select id="github-import-provider" bind:value={providerId} disabled={busy || createSubmitted || !!newProjectId} class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"><option value="">Select a provider</option>{#each providers as provider}<option value={provider.installationId} disabled={!provider.ready}>{provider.label}</option>{/each}{#each incusEnvironments as environment}<option value={environmentKey(environment)}>{environment.label}</option>{/each}</select></div>{/if}
			</div>
			{#if selectedRepository?.accessStatus === "insufficient_user_permission"}<p class="mt-2 text-sm text-amber-700 dark:text-amber-300" role="status">Your GitHub account needs write access to this repository.</p>{/if}
			{#if incusNotice}<p class="mt-2 text-sm text-[var(--color-text-secondary)]" role="status">{incusNotice}</p>{/if}
			{#if selectedIncus || incusRequest}
				<p class="mt-2 text-sm text-[var(--color-text-secondary)]">This import starts a new private Incus workspace. It copies a source snapshot, without full Git history, submodules, or Git LFS content. Limits: 64 KiB per file, 2,000 files, 32 MiB total, and 240 UTF-8 bytes per relative path.</p>
				{#if incusUnknown || error && incusRequest}<p class="mt-2 text-sm text-amber-700 dark:text-amber-300" role="status">{#if incusPartial}The source transfer needs review. Inspect the workspace in Incus management and dispose of it if needed. This form will not repeat file writes.{:else}{incusUnknown ? "The operation outcome is unknown." : "The import did not finish."} Keep this form open. Inspect Incus management for a saved operation before retrying. Retry keeps the same request and key and resumes the saved source if an operation exists.{/if} <a class="underline" href="/extensions/incus-management">Inspect saved operation in Incus management</a></p>{/if}
			{/if}
				<button class="mt-3 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy || incusPartial || !validBaseRef || selectedRepository?.accessStatus !== "ready" || !pendingPrivate && !selectedProvider?.ready && !selectedIncus && !incusRequest} onclick={importRepository}>{busy ? "Importing repository…" : incusPartial ? "Source transfer needs review" : incusRequest ? "Retry saved import" : pendingPrivate ? "Import into this sandbox" : "Create private sandbox & import"}</button>
			{:else}<p class="mt-3 text-sm text-[var(--color-text-secondary)]">No enabled repositories are available. Enable a repository or request organization approval on GitHub.</p>{/if}
			{#if trustedGithubUrl(connection.installUrl)}<a class="mt-3 block text-sm text-[var(--color-accent)] underline" href={trustedGithubUrl(connection.installUrl) ?? undefined} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Enable repositories on GitHub</a>{/if}
		<a class="mt-3 block text-xs text-[var(--color-accent)] underline" href="/settings/github">Manage GitHub connection</a>
	{/if}
	{#if newProjectId && error}<a class="mt-3 block text-sm text-[var(--color-accent)] underline" href={`/project/${newProjectId}${incusRequest ? "" : "/settings"}`}>Open the private sandbox</a>{/if}
</section>
