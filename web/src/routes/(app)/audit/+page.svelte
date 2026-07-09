<script lang="ts">
	/**
	 * Phase 52.4 — global admin audit page. Admin-only, server-gated.
	 *
	 * Top: stats strip (denials, total calls, total cost, top-3
	 * chattiest, top-3 LLM spenders).
	 * Filters: search input + extension picker + capability picker +
	 * denial-only toggle + user-id filter.
	 * Body: paginated timeline (cursor-based).
	 */
	import { onMount } from "svelte";
	import { addToast } from "$lib/toast.svelte.js";
	// Shared sign-aware USD formatter (renders identically to the old
	// local `fmtCost` for this page's non-negative cost inputs).
	import { fmtUsd } from "$lib/savings-format";
	import type { PageData } from "./$types";

	const { data }: { data: PageData } = $props();

	type Entry = (typeof data.entries)[number];

	let entries = $state<Entry[]>(data.entries);
	let nextCursor = $state<string | null>(data.nextCursor);
	let stats = $state(data.stats);
	let loading = $state(false);
	let extensionFacets = data.extensionFacets;

	// Filter state
	let searchInput = $state("");
	let extensionFilter = $state<string>("");
	let capabilityFilter = $state<string>("");
	let denialOnly = $state(false);
	let userFilter = $state("");

	function buildQs(opts: { cursor?: string | null } = {}): string {
		const qs = new URLSearchParams();
		if (extensionFilter) qs.set("extensionId", extensionFilter);
		if (capabilityFilter) qs.set("capability", capabilityFilter);
		if (denialOnly) qs.set("denialOnly", "true");
		if (userFilter) qs.set("onBehalfOf", userFilter);
		if (searchInput) qs.set("search", searchInput);
		if (opts.cursor) qs.set("cursor", opts.cursor);
		return qs.toString();
	}

	async function applyFilters() {
		loading = true;
		try {
			const res = await fetch(`/api/audit?${buildQs()}`);
			if (!res.ok) throw new Error(`Audit fetch failed: ${res.status}`);
			const body = (await res.json()) as { entries: Entry[]; nextCursor: string | null };
			entries = body.entries;
			nextCursor = body.nextCursor;
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Audit fetch failed" });
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (!nextCursor) return;
		loading = true;
		try {
			const res = await fetch(`/api/audit?${buildQs({ cursor: nextCursor })}`);
			if (!res.ok) throw new Error(`Audit fetch failed: ${res.status}`);
			const body = (await res.json()) as { entries: Entry[]; nextCursor: string | null };
			entries = [...entries, ...body.entries];
			nextCursor = body.nextCursor;
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Audit fetch failed" });
		} finally {
			loading = false;
		}
	}

	async function refreshStats() {
		try {
			const res = await fetch(`/api/audit/stats?range=24h`);
			if (res.ok) stats = await res.json();
		} catch {
			// non-fatal
		}
	}

	onMount(() => {
		void refreshStats();
	});

	function fmtDate(d: string | Date): string {
		const date = typeof d === "string" ? new Date(d) : d;
		return date.toLocaleString();
	}

	function entryIcon(entry: Entry): string {
		if (entry.kind === "governance") return "⚙️";
		if (entry.kind === "resource") return entry.resourceKind === "memory" ? "🧠" : "📚";
		if (!entry.success) return "🚫";
		if (entry.capability === "llm") return "🤖";
		if (entry.capability === "memory") return "🧠";
		if (entry.capability === "lessons") return "📚";
		if (entry.capability === "schedule") return "📅";
		if (entry.capability === "events") return "📡";
		return "·";
	}

	function entryLabel(entry: Entry): string {
		if (entry.kind === "governance") return entry.action;
		if (entry.kind === "resource") return `${entry.resourceKind}.${entry.action}`;
		return `${entry.capability}.${entry.action}`;
	}

	let extensionNameById = $derived.by(() => {
		const m = new Map<string, string>();
		for (const e of extensionFacets) m.set(e.id, e.name);
		return m;
	});

	function entryExtensionName(entry: Entry): string {
		if (entry.kind === "governance") {
			return entry.target ? extensionNameById.get(entry.target) ?? entry.target.slice(0, 8) : "system";
		}
		// capability/resource — we don't carry extensionId on the
		// merged shape today (it's filtered server-side via the
		// extensionId query param). Surface "(filtered)" if a filter
		// is active, otherwise rely on the resource id.
		if (extensionFilter) return extensionNameById.get(extensionFilter) ?? extensionFilter.slice(0, 8);
		return "—";
	}
</script>

<svelte:head>
	<title>Audit · Admin</title>
</svelte:head>

<div class="space-y-6">
	<h1 class="text-xl font-semibold text-[var(--color-text-primary)]">Audit</h1>

	<!-- Stats strip -->
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="global-audit-stats">
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
			<div class="text-xs text-[var(--color-text-muted)]">24h calls</div>
			<div class="text-2xl font-semibold text-[var(--color-text-primary)]" data-testid="stats-total-calls">{stats.totalCalls}</div>
		</div>
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
			<div class="text-xs text-[var(--color-text-muted)]">24h denials</div>
			<div class="text-2xl font-semibold {stats.denialCount > 0 ? 'text-red-400' : 'text-[var(--color-text-primary)]'}" data-testid="stats-denials">{stats.denialCount}</div>
		</div>
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
			<div class="text-xs text-[var(--color-text-muted)]">24h LLM spend</div>
			<div class="text-2xl font-semibold text-[var(--color-text-primary)]" data-testid="stats-cost">{fmtUsd(stats.totalCostUsd)}</div>
			<div class="text-[10px] text-[var(--color-text-muted)]">approximate; provider billing may differ</div>
		</div>
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
			<div class="mb-1 text-xs text-[var(--color-text-muted)]">Top chattiest</div>
			{#if stats.topChattiest.length === 0}
				<div class="text-sm text-[var(--color-text-muted)]">—</div>
			{:else}
				<ol class="space-y-0.5 text-xs" data-testid="stats-chattiest">
					{#each stats.topChattiest as ext (ext.extensionId)}
						<li class="flex items-baseline justify-between gap-2">
							<span class="truncate text-[var(--color-text-primary)]">{ext.name}</span>
							<span class="text-[var(--color-text-muted)]">{ext.calls}</span>
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	</div>
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
		<div class="mb-1 text-xs text-[var(--color-text-muted)]">Top LLM spenders (24h)</div>
		{#if stats.topLlmSpenders.length === 0}
			<div class="text-sm text-[var(--color-text-muted)]">—</div>
		{:else}
			<ol class="space-y-0.5 text-xs" data-testid="stats-spenders">
				{#each stats.topLlmSpenders as ext (ext.extensionId)}
					<li class="flex items-baseline justify-between gap-2">
						<span class="truncate text-[var(--color-text-primary)]">{ext.name}</span>
						<span class="text-[var(--color-text-muted)]">{fmtUsd(ext.costUsd)}</span>
					</li>
				{/each}
			</ol>
		{/if}
	</div>

	<!-- Filters -->
	<div class="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3" data-testid="global-audit-filters">
		<label class="flex flex-col gap-1 text-xs">
			<span class="text-[var(--color-text-muted)]">Search</span>
			<input
				type="text"
				bind:value={searchInput}
				placeholder="resource id / error / model"
				class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
				onkeydown={(e) => { if (e.key === 'Enter') void applyFilters(); }}
			/>
		</label>
		<label class="flex flex-col gap-1 text-xs">
			<span class="text-[var(--color-text-muted)]">Extension</span>
			<select
				bind:value={extensionFilter}
				onchange={() => applyFilters()}
				class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
				data-testid="filter-extension"
			>
				<option value="">All</option>
				{#each extensionFacets as ext (ext.id)}
					<option value={ext.id}>{ext.name}{ext.isBundled ? " (built-in)" : ""}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1 text-xs">
			<span class="text-[var(--color-text-muted)]">Capability</span>
			<select
				bind:value={capabilityFilter}
				onchange={() => applyFilters()}
				class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
				data-testid="filter-capability"
			>
				<option value="">All</option>
				<option value="llm">LLM</option>
				<option value="memory">Memory</option>
				<option value="lessons">Lessons</option>
				<option value="schedule">Schedule</option>
				<option value="events">Events</option>
			</select>
		</label>
		<label class="flex flex-col gap-1 text-xs">
			<span class="text-[var(--color-text-muted)]">User id</span>
			<input
				type="text"
				bind:value={userFilter}
				class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
				onkeydown={(e) => { if (e.key === 'Enter') void applyFilters(); }}
			/>
		</label>
		<label class="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
			<input
				type="checkbox"
				bind:checked={denialOnly}
				onchange={() => applyFilters()}
				data-testid="filter-denial-only"
			/>
			Denials only
		</label>
		<button
			onclick={applyFilters}
			disabled={loading}
			class="rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
		>
			{loading ? "…" : "Apply"}
		</button>
	</div>

	<!-- Timeline -->
	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]" data-testid="global-audit-timeline">
		{#if entries.length === 0}
			<div class="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
				{loading ? "Loading…" : "No audit entries match the current filters."}
			</div>
		{:else}
			<ul class="divide-y divide-[var(--color-border)]">
				{#each entries as entry (entry.id)}
					<li class="px-4 py-3 text-sm" data-testid="global-audit-row" data-entry-kind={entry.kind}>
						<div class="flex items-start gap-3">
							<span class="mt-0.5 text-base">{entryIcon(entry)}</span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-medium text-[var(--color-text-primary)]">{entryLabel(entry)}</span>
									<span class="rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">{entryExtensionName(entry)}</span>
									{#if entry.kind === "capability" && !entry.success}
										<span class="rounded-full bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-300">denied</span>
									{/if}
								</div>
								<p class="truncate text-xs text-[var(--color-text-secondary)]">
									{#if entry.kind === "capability"}
										{entry.model ?? ""} {#if entry.tokensUsed != null}· {(entry.tokensUsed / 1000).toFixed(1)}k tok{/if} {#if entry.costUsd != null}· {fmtUsd(entry.costUsd)}{/if} · {entry.durationMs}ms
									{:else if entry.kind === "resource"}
										{entry.resourceKind} {entry.resourceId.slice(0, 12)}
									{:else}
										{(entry.metadata as { reason?: string })?.reason ?? entry.target ?? ""}
									{/if}
								</p>
							</div>
							<div class="text-right text-xs text-[var(--color-text-muted)] whitespace-nowrap">
								{fmtDate(entry.createdAt)}
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if nextCursor}
			<div class="border-t border-[var(--color-border)] px-4 py-3 text-center">
				<button
					onclick={loadMore}
					disabled={loading}
					class="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
					data-testid="global-audit-load-more"
				>
					{loading ? "Loading…" : "Load more"}
				</button>
			</div>
		{/if}
	</div>
</div>
