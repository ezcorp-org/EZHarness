<script lang="ts">
	import { goto } from "$app/navigation";
	import { refreshProjects } from "$lib/stores.svelte.js";

	type Provider = { installationId: string; providerId: string; label: string; ready: boolean; reason?: string };
	type SandboxStatus = { state: string; operation?: { id: string; state: string } | null; provider?: { label: string } | null };

	let { projectId, sandbox = false }: { projectId: string; sandbox?: boolean } = $props();
	let providers = $state<Provider[]>([]);
	let status = $state<SandboxStatus | null>(null);
	let busy = $state(false);
	let error = $state("");
	let disposeOpen = $state(false);
	const disposed = $derived(status?.state === "destroyed");

	async function load() {
		error = "";
		try {
			const endpoint = sandbox ? `/api/projects/${encodeURIComponent(projectId)}/sandbox` : "/api/sandboxes/providers";
			const response = await fetch(endpoint);
			if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "Sandbox service is unavailable" }))).error);
			if (sandbox) status = await response.json(); else providers = (await response.json()).providers ?? [];
		} catch (cause) { error = cause instanceof Error ? cause.message : "Sandbox service is unavailable"; }
	}

	$effect(() => { load(); });

	async function create(provider: Provider) {
		busy = true; error = "";
		try {
			const response = await fetch("/api/sandboxes", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ name: `Sandbox for ${projectId}`, providerInstallationId: provider.installationId, providerId: provider.providerId }) });
			if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "Could not create sandbox" }))).error);
			const data = await response.json();
			if (!await refreshProjects()) throw new Error("Could not load the new sandbox");
			await goto(`/project/${data.project.id}/settings`);
		} catch (cause) { error = cause instanceof Error ? cause.message : "Could not create sandbox"; } finally { busy = false; }
	}

	async function action(action: "start" | "stop" | "destroy") {
		busy = true; error = "";
		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sandbox`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action }) });
			if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "Sandbox action failed" }))).error);
			status = await response.json() as SandboxStatus;
			disposeOpen = false;
		} catch (cause) { error = cause instanceof Error ? cause.message : "Sandbox action failed"; } finally { busy = false; }
	}
</script>

<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6" data-testid="project-sandbox-panel">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div><h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Local sandbox</h3><p class="mt-1 text-sm text-[var(--color-text-secondary)]">Create a separate workspace for a task. Files stay here until you remove the sandbox.</p></div>
		{#if sandbox && status}<span class="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-accent)]">{status.state}</span>{/if}
	</div>
	{#if error}<p class="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>{/if}
	{#if sandbox}
		<div class="mt-4 flex flex-wrap gap-2"><button class="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white" disabled={busy || disposed} onclick={() => action("start")}>Start</button><button class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm" disabled={busy || disposed} onclick={() => action("stop")}>Stop</button><a class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm" href={`/project/${projectId}`}>Open chat</a><button class="ml-auto rounded-md px-3 py-1.5 text-sm text-red-700 hover:bg-red-500/10 dark:text-red-300" disabled={busy || disposed} onclick={() => disposeOpen = true}>Dispose…</button></div>
		{#if disposeOpen}<div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-3"><p class="text-sm text-red-700 dark:text-red-300">Dispose this sandbox permanently? Workspace changes cannot be recovered.</p><div class="mt-3 flex gap-2"><button class="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white" disabled={busy || disposed} onclick={() => action("destroy")}>Dispose sandbox</button><button class="rounded-md px-3 py-1.5 text-sm" onclick={() => disposeOpen = false}>Cancel</button></div></div>{/if}
	{:else if providers.length}
		<div class="mt-4 grid gap-2 sm:grid-cols-2">{#each providers as provider}<button class="rounded-md border border-[var(--color-border)] p-3 text-left hover:bg-[var(--color-surface-tertiary)]" disabled={busy || !provider.ready} onclick={() => create(provider)}><span class="block text-sm font-medium text-[var(--color-text-primary)]">{provider.label}</span><span class="mt-1 block text-xs text-[var(--color-text-muted)]">{provider.ready ? "Create a dedicated sandbox" : provider.reason ?? "Needs review"}</span></button>{/each}</div>
	{:else}<p class="mt-4 text-sm text-[var(--color-text-muted)]">No reviewed local sandbox provider is available. Install and review a provider to create one.</p>{/if}
</section>

<style>
	button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
