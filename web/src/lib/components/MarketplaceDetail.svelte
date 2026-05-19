<script lang="ts">
	import type { MarketplaceListing, MarketplaceVersion } from "$lib/api.js";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";

	let {
		listing,
		versions = [],
		userRating = null,
		isAuthor = false,
		isAdmin = false,
		installed = false,
		oninstall,
		onrate,
		onflag,
		onexport,
		onupdate,
		ondismissflag,
		onremove,
	}: {
		listing: MarketplaceListing;
		versions?: MarketplaceVersion[];
		userRating?: boolean | null;
		isAuthor?: boolean;
		isAdmin?: boolean;
		installed?: boolean;
		oninstall: () => void;
		onrate: (thumbsUp: boolean) => void;
		onflag: () => void;
		onexport: () => void;
		onupdate?: () => void;
		ondismissflag?: () => void;
		onremove?: () => void;
	} = $props();

	let activeTab = $state<"description" | "versions" | "examples">("description");

	let ratingDisplay = $derived(
		listing.ratingTotal > 0 ? `${listing.ratingPercent}%` : "No ratings yet",
	);

	let latestManifest = $derived(
		versions[0]?.manifest as Record<string, unknown> | undefined,
	);
	let agentDef = $derived(latestManifest?.agent as Record<string, unknown> | undefined);
	let extensions = $derived(
		(latestManifest?.extensions as Array<{ name: string; source: string; version: string; required: boolean }>) ?? [],
	);
	let exampleConversations = $derived(
		(agentDef?.exampleConversations as Array<{ title: string; messages: Array<{ role: string; content: string }> }>) ?? [],
	);

</script>

<!-- Flag notification for authors -->
{#if isAuthor && listing.status === "flagged"}
	<div class="mb-4 rounded-lg border border-amber-600/50 bg-amber-900/30 p-4">
		<div class="flex items-start gap-3">
			<svg class="mt-0.5 h-5 w-5 shrink-0 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
				<path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
			</svg>
			<div>
				<h3 class="font-semibold text-amber-300">This listing has been flagged for review</h3>
				<p class="mt-1 text-sm text-amber-200/80">
					This listing is currently hidden from marketplace search. An admin will review it shortly.
				</p>
			</div>
		</div>
	</div>
{/if}

<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
	<!-- Header -->
	<div class="mb-4 flex items-start justify-between gap-4">
		<div>
			<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">{listing.name}</h2>
			<div class="mt-1 flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
				{#if listing.authorName}
					<span>by {listing.authorName}</span>
				{/if}
				<span class="rounded bg-blue-900/40 px-1.5 py-0.5 text-xs text-blue-300">{listing.category}</span>
				<span>v{listing.latestVersion}</span>
				<span>{listing.installCount} installs</span>
			</div>
		</div>
		<div class="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
			<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
				<path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
			</svg>
			<span>{ratingDisplay}</span>
		</div>
	</div>

	<!-- Action row -->
	<div class="mb-6 flex flex-wrap items-center gap-3">
		{#if isAuthor}
			<button
				onclick={() => onupdate?.()}
				class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
			>
				Update Version
			</button>
		{:else}
			<button
				onclick={oninstall}
				disabled={installed}
				class="rounded-md px-4 py-2 text-sm font-medium transition-colors
					{installed ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-500'}"
			>
				{installed ? "Installed" : "Install"}
			</button>
		{/if}

		<!-- Rating buttons -->
		<div class="flex items-center gap-1 rounded-md border border-[var(--color-border)]">
			<button
				onclick={() => onrate(true)}
				class="rounded-l-md px-3 py-2 text-sm transition-colors
					{userRating === true ? 'bg-green-600/30 text-green-400' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-green-400'}"
				title="Thumbs up"
			>
				<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
					<path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
				</svg>
			</button>
			<button
				onclick={() => onrate(false)}
				class="rounded-r-md border-l border-[var(--color-border)] px-3 py-2 text-sm transition-colors
					{userRating === false ? 'bg-red-600/30 text-red-400' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-red-400'}"
				title="Thumbs down"
			>
				<svg class="h-4 w-4 rotate-180" fill="currentColor" viewBox="0 0 20 20">
					<path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
				</svg>
			</button>
		</div>

		<button
			onclick={onexport}
			class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
		>
			Export
		</button>

		{#if !isAuthor && !isAdmin}
			<button
				onclick={onflag}
				class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-red-400"
			>
				Report
			</button>
		{/if}

		{#if isAdmin && listing.status === "flagged"}
			<button
				onclick={() => ondismissflag?.()}
				class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs font-medium text-yellow-400 transition-colors hover:bg-[var(--color-surface-tertiary)]"
			>
				Dismiss Flag
			</button>
			<button
				onclick={() => onremove?.()}
				class="rounded-md bg-red-600/80 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-500"
			>
				Remove
			</button>
		{/if}
	</div>

	<!-- Tabs -->
	<div class="mb-4 flex gap-1 border-b border-[var(--color-border)]">
		{#each [
			{ key: "description", label: "Description" },
			{ key: "versions", label: `Versions (${versions.length})` },
			...(exampleConversations.length > 0 ? [{ key: "examples", label: "Examples" }] : []),
		] as tab}
			<button
				onclick={() => (activeTab = tab.key as typeof activeTab)}
				class="border-b-2 px-4 py-2 text-sm font-medium transition-colors
					{activeTab === tab.key
					? 'border-blue-500 text-blue-400'
					: 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
			>
				{tab.label}
			</button>
		{/each}
	</div>

	<!-- Tab content -->
	{#if activeTab === "description"}
		<div class="space-y-4">
			<MarkdownRenderer content={listing.description} />

			{#if extensions.length > 0}
				<div class="mt-4">
					<h4 class="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Required Extensions</h4>
					<div class="space-y-1">
						{#each extensions as ext}
							<div class="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
								<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-xs">{ext.name}</span>
								<span class="text-xs text-[var(--color-text-muted)]">{ext.source}</span>
								{#if ext.required}
									<span class="text-xs text-amber-400">required</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{:else if activeTab === "versions"}
		<div class="space-y-3">
			{#each versions as ver (ver.id)}
				<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
					<div class="flex items-center justify-between">
						<span class="font-mono text-sm font-semibold text-[var(--color-text-primary)]">v{ver.version}</span>
						<span class="text-xs text-[var(--color-text-muted)]">{new Date(ver.createdAt).toLocaleDateString()}</span>
					</div>
					{#if ver.changelog}
						<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{ver.changelog}</p>
					{/if}
				</div>
			{/each}
			{#if versions.length === 0}
				<p class="text-sm text-[var(--color-text-muted)]">No version history available.</p>
			{/if}
		</div>
	{:else if activeTab === "examples"}
		<div class="space-y-4">
			{#each exampleConversations as conv, i}
				<details class="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
					<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
						{conv.title || `Example ${i + 1}`}
					</summary>
					<div class="border-t border-[var(--color-border)] px-4 py-3 space-y-2">
						{#each conv.messages as msg}
							<div class="flex gap-2 text-sm">
								<span class="shrink-0 font-semibold {msg.role === 'user' ? 'text-blue-400' : 'text-green-400'}">
									{msg.role === "user" ? "User:" : "Assistant:"}
								</span>
								<span class="text-[var(--color-text-secondary)]">{msg.content}</span>
							</div>
						{/each}
					</div>
				</details>
			{/each}
		</div>
	{/if}
</div>
