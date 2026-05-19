<script lang="ts">
	import { goto } from "$app/navigation";
	import {
		fetchUserCommands,
		deleteUserCommand as apiDeleteUserCommand,
		type UserCommand,
	} from "$lib/api.js";
	import { addToast } from "$lib/toast.svelte.js";
	import CommandCard from "$lib/components/CommandCard.svelte";
	import EmptyState from "$lib/components/EmptyState.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import { onMount } from "svelte";

	let commands = $state<UserCommand[]>([]);
	let loading = $state(true);
	let errorMsg = $state("");
	let pendingDelete = $state<string | null>(null);

	onMount(async () => {
		try {
			commands = await fetchUserCommands();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to load commands";
		} finally {
			loading = false;
		}
	});

	function handleEdit(name: string) {
		goto(`/commands/${encodeURIComponent(name)}`);
	}

	async function handleDelete(name: string) {
		// Browser-native confirm dialog keeps the v1 surface area small;
		// the e2e test stubs `window.confirm` to drive the flow.
		const ok = typeof window !== "undefined" ? window.confirm(`Delete /${name}?`) : false;
		if (!ok) return;
		pendingDelete = name;
		try {
			await apiDeleteUserCommand(name);
			commands = commands.filter((c) => c.name !== name);
			addToast({ type: "success", message: `Deleted /${name}` });
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to delete";
			addToast({ type: "error", message: msg });
		} finally {
			pendingDelete = null;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">Commands</h2>
		<div class="flex items-center gap-2">
			<a
				href="/import"
				class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
				data-testid="commands-import-link"
			>
				Import…
			</a>
			<a
				href="/commands/new"
				class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
			>
				+ New Command
			</a>
		</div>
	</div>

	<p class="max-w-2xl text-sm text-[var(--color-text-muted)]">
		Personal slash commands available in any chat. Type <code>/</code> in the composer to insert one.
		Use <code>$ARGUMENTS</code> in the body for the full argument string, or <code>$1</code>, <code>$2</code>, …
		for positional values.
	</p>

	{#if errorMsg}
		<p class="text-sm text-red-400" data-testid="commands-page-error">{errorMsg}</p>
	{/if}

	{#if loading}
		<SkeletonLoader type="card-grid" count={6} />
	{:else if commands.length === 0}
		<EmptyState
			title="No commands yet"
			description="Slash commands are reusable prompt templates. Create your first one to get started."
			ctaLabel="Create Command"
			ctaHref="/commands/new"
		>
			{#snippet icon()}
				<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
				</svg>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="commands-grid">
			{#each commands as command (command.id)}
				<CommandCard
					{command}
					onedit={() => handleEdit(command.name)}
					ondelete={pendingDelete === command.name ? undefined : () => handleDelete(command.name)}
				/>
			{/each}
		</div>
	{/if}
</div>
