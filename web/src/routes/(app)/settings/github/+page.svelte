<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";

	type Connection = {
		status: "disconnected" | "connected" | "reconnect_required";
		configured: boolean;
		account?: { id: number; login: string };
	};
	type RepositoryCheck = {
		status: "ready" | "repository_not_enabled" | "organization_approval_pending" | "insufficient_user_permission" | "reconnect_required";
		repository?: { id: number; fullName: string };
		installUrl?: string;
		manageUrl?: string;
	};

	let connection = $state<Connection | null>(null);
	let connectionLoaded = $state(false);
	let repository = $state<RepositoryCheck | null>(null);
	let busy = $state(false);
	let error = $state("");
	let confirmDisconnect = $state(false);
	let approvalRequested = $state(false);
	let checkingRepository = $state(false);

	const repositoryId = $derived(Number(page.url.searchParams.get("repositoryId")));
	const returnReviewId = $derived(page.url.searchParams.get("review") ?? undefined);

	async function readJson(response: Response) {
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(body.error ?? body.message ?? "GitHub is unavailable");
		return body;
	}

	async function load() {
		error = "";
		try {
			connection = await readJson(await fetch("/api/github/connection")) as Connection;
			if (connection.status === "connected" && Number.isSafeInteger(repositoryId) && repositoryId > 0) {
				await recheckRepository();
			} else {
				repository = null;
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "GitHub is unavailable";
		} finally { connectionLoaded = true; }
	}

	async function recheckRepository() {
		if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return;
		checkingRepository = true;
		error = "";
		try {
			repository = await readJson(await fetch(`/api/github/repositories/check?repositoryId=${repositoryId}`)) as RepositoryCheck;
			if (repository.status === "ready") approvalRequested = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not check repository access";
		} finally { checkingRepository = false; }
	}

	onMount(() => { void load(); });

	async function connect() {
		busy = true;
		error = "";
		try {
			const body = returnReviewId ? { returnReviewId } : {};
			const result = await readJson(await fetch("/api/github/authorize", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})) as { authorizeUrl: string };
			const authorizeUrl = new URL(result.authorizeUrl);
			if (authorizeUrl.protocol !== "https:" || authorizeUrl.hostname !== "github.com" || authorizeUrl.pathname !== "/login/oauth/authorize") {
				throw new Error("GitHub returned an invalid authorization address");
			}
			window.location.assign(authorizeUrl.href);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not connect GitHub";
			busy = false;
		}
	}

	async function disconnect() {
		busy = true;
		error = "";
		try {
			connection = await readJson(await fetch("/api/github/connection", { method: "DELETE" })) as Connection;
			repository = null;
			confirmDisconnect = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not disconnect GitHub";
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>GitHub - Settings - EZCorp</title>
</svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-6" data-testid="github-settings">
	<div>
		<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">GitHub</h2>
		<p class="mt-1 text-sm text-[var(--color-text-secondary)]">Connect your GitHub account once to import a repository into a private sandbox and create draft pull requests from your work.</p>
	</div>

	<SettingsSection title="Your account" description="This connection belongs to you. Other EZCorp users cannot use it, even in a shared project.">
		{#if error}<p class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>{/if}
		{#if !connectionLoaded}
			<p class="text-sm text-[var(--color-text-secondary)]" role="status">Checking GitHub connection…</p>
		{:else if !connection}
			<p class="text-sm text-[var(--color-text-secondary)]" role="status">Could not load your GitHub connection. Reload this page to try again.</p>
		{:else if !connection.configured}
			<p class="text-sm text-[var(--color-text-secondary)]" role="status">GitHub connection is not configured on this EZCorp server. Ask an administrator to set up the GitHub App.</p>
		{:else if connection.status === "disconnected"}
			<p class="mb-4 text-sm text-[var(--color-text-secondary)]" role="status">No GitHub account connected.</p>
			<button class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy} onclick={connect}>Connect GitHub</button>
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-4">
				<div>
					<p class="font-medium text-[var(--color-text-primary)]">{connection.account?.login ?? "GitHub account"}</p>
					<p class="text-sm text-[var(--color-text-secondary)]" role="status">{connection.status === "connected" ? "Connected" : "Reconnect required. Draft pull requests are paused."}</p>
				</div>
				<div class="flex flex-wrap gap-2">
					<button class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50" disabled={busy} onclick={connect}>Reconnect</button>
					<button class="rounded-md border border-red-500/30 px-3 py-2 text-sm text-red-700 hover:bg-red-500/10 dark:text-red-300 disabled:opacity-50" disabled={busy} onclick={() => confirmDisconnect = true}>Disconnect</button>
				</div>
			</div>
			{#if confirmDisconnect}
				<div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-4">
					<p class="text-sm text-[var(--color-text-primary)]">Disconnect your GitHub account? Pending draft pull requests will stop until you reconnect.</p>
					<div class="mt-3 flex gap-2">
						<button class="rounded-md bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50" disabled={busy} onclick={disconnect}>Disconnect GitHub</button>
						<button class="rounded-md px-3 py-2 text-sm text-[var(--color-text-secondary)]" disabled={busy} onclick={() => confirmDisconnect = false}>Cancel</button>
					</div>
				</div>
			{/if}
		{/if}
	</SettingsSection>

	{#if repository}
		<SettingsSection title="Repository access" description="GitHub controls which repositories and organizations this connection can use.">
			<p class="text-sm font-medium text-[var(--color-text-primary)]">{repository.repository?.fullName ?? "Selected repository"}</p>
			<p class="mt-1 text-sm text-[var(--color-text-secondary)]" role="status">
				{#if repository.status === "ready"}Ready for private sandbox import and draft pull requests.
				{:else if repository.status === "repository_not_enabled"}{approvalRequested ? "Approval may be pending. GitHub has not enabled this repository yet." : "Enable this repository for the GitHub App."}
				{:else if repository.status === "organization_approval_pending"}Your organization must approve the GitHub App.
				{:else if repository.status === "insufficient_user_permission"}Your account needs repository write access.
				{:else}Reconnect your GitHub account to check this repository.{/if}
			</p>
			{#if repository.installUrl}<a class="mt-3 inline-block text-sm text-[var(--color-accent)] underline" href={repository.installUrl} rel="noopener noreferrer">Enable repository on GitHub</a>{/if}
			{#if repository.manageUrl}<a class="mt-3 inline-block text-sm text-[var(--color-accent)] underline" href={repository.manageUrl} rel="noopener noreferrer">Manage organization approval</a>{/if}
			{#if repository.status === "repository_not_enabled"}<div class="mt-3 flex flex-wrap gap-3"><button class="text-sm text-[var(--color-accent)] underline" onclick={() => approvalRequested = true}>I requested approval</button><button class="text-sm text-[var(--color-accent)] underline disabled:opacity-50" disabled={checkingRepository} onclick={recheckRepository}>{checkingRepository ? "Checking…" : "Recheck access"}</button></div>{/if}
		</SettingsSection>
	{/if}
</div>
