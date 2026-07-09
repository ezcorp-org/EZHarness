<script lang="ts">
	/**
	 * Phase 52.2 — per-extension audit drill-down.
	 *
	 * Three columns on desktop (stacks on mobile):
	 *   - left: filter pills + date range + paginated timeline
	 *   - right: 24h stats strip (sticky at top of column)
	 *   - right (below): "Current grants" snapshot for cross-referencing
	 *     denials with the manifest's declared permissions.
	 */
	import { onMount } from "svelte";
	import { addToast } from "$lib/toast.svelte.js";
	// Shared sign-aware USD formatter (renders identically to the old
	// local `fmtCost` for this page's non-negative cost inputs).
	import { fmtUsd } from "$lib/savings-format";
	import type { PageData } from "./$types";

	const { data }: { data: PageData } = $props();

	type CapabilityFilter = "all" | "llm" | "memory" | "lessons" | "schedule" | "events" | "denials";

	let entries = $state(data.entries);
	let nextCursor = $state<string | null>(data.nextCursor);
	let stats = $state(data.stats);
	let loading = $state(false);
	let activeFilter = $state<CapabilityFilter>("all");
	let sinceInput = $state("");
	let untilInput = $state("");
	let expandedId = $state<string | null>(null);

	// Filter pill definitions — id matches the API's `?capability=` value;
	// "denials" maps to `?status=denial`.
	const FILTERS: Array<{ id: CapabilityFilter; label: string; icon: string }> = [
		{ id: "all", label: "All", icon: "·" },
		{ id: "llm", label: "LLM", icon: "🤖" },
		{ id: "memory", label: "Memory", icon: "🧠" },
		{ id: "lessons", label: "Lessons", icon: "📚" },
		{ id: "schedule", label: "Schedule", icon: "📅" },
		{ id: "events", label: "Events", icon: "📡" },
		{ id: "denials", label: "Denials", icon: "🚫" },
	];

	function buildQs(opts: { cursor?: string | null } = {}): string {
		const qs = new URLSearchParams();
		if (activeFilter !== "all") {
			if (activeFilter === "denials") qs.set("status", "denial");
			else qs.set("capability", activeFilter);
		}
		if (sinceInput) qs.set("since", sinceInput);
		if (untilInput) qs.set("until", untilInput);
		if (opts.cursor) qs.set("cursor", opts.cursor);
		return qs.toString();
	}

	async function applyFilters() {
		loading = true;
		expandedId = null;
		try {
			const qs = buildQs();
			const res = await fetch(`/api/extensions/${data.extension.id}/audit?${qs}`);
			if (!res.ok) throw new Error(`Audit fetch failed: ${res.status}`);
			const body = (await res.json()) as { entries: typeof entries; nextCursor: string | null };
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
			const qs = buildQs({ cursor: nextCursor });
			const res = await fetch(`/api/extensions/${data.extension.id}/audit?${qs}`);
			if (!res.ok) throw new Error(`Audit fetch failed: ${res.status}`);
			const body = (await res.json()) as { entries: typeof entries; nextCursor: string | null };
			entries = [...entries, ...body.entries];
			nextCursor = body.nextCursor;
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Audit fetch failed" });
		} finally {
			loading = false;
		}
	}

	function selectFilter(id: CapabilityFilter) {
		activeFilter = id;
		void applyFilters();
	}

	async function refreshStats() {
		try {
			const res = await fetch(`/api/extensions/${data.extension.id}/audit/stats?range=24h`);
			if (res.ok) stats = await res.json();
		} catch {
			// non-fatal — strip stays on prior values
		}
	}

	onMount(() => {
		// Refresh stats client-side so a long-lived tab gets fresh
		// numbers without a full reload. Same SSR data is the first
		// paint anchor.
		void refreshStats();
	});

	function fmtDate(d: string | Date): string {
		const date = typeof d === "string" ? new Date(d) : d;
		return date.toLocaleString();
	}

	function fmtPercent(rate: number): string {
		return `${(rate * 100).toFixed(1)}%`;
	}

	function entryIcon(entry: typeof entries[number]): string {
		if (entry.kind === "governance") return "⚙️";
		if (entry.kind === "resource") return entry.resourceKind === "memory" ? "🧠" : "📚";
		// capability
		const cap = entry.capability;
		if (!entry.success) return "🚫";
		if (cap === "llm") return "🤖";
		if (cap === "memory") return "🧠";
		if (cap === "lessons") return "📚";
		if (cap === "schedule") return "📅";
		if (cap === "events") return "📡";
		return "·";
	}

	function entryLabel(entry: typeof entries[number]): string {
		if (entry.kind === "governance") return entry.action;
		if (entry.kind === "resource") return `${entry.resourceKind} ${entry.action}`;
		return `${entry.capability} ${entry.action}`;
	}

	function entrySummary(entry: typeof entries[number]): string {
		if (entry.kind === "governance") {
			const meta = entry.metadata ?? {};
			const reason = (meta as { reason?: string }).reason;
			return reason ?? `target=${entry.target ?? "unknown"}`;
		}
		if (entry.kind === "resource") {
			return `${entry.resourceKind} ${entry.resourceId.slice(0, 8)}…`;
		}
		const c = entry;
		const tokenStr = c.tokensUsed ? `${(c.tokensUsed / 1000).toFixed(1)}k tok` : "";
		const modelStr = c.model ?? "";
		return [modelStr, tokenStr].filter(Boolean).join(" · ");
	}

	function toggleExpand(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	// Granted-permissions snapshot for the right-rail. Renders the
	// keys verbatim so an admin reviewing a denial can spot a mismatch
	// (e.g. denial says "no llm:openai grant" + sidebar shows
	// `llm.providers: ["anthropic"]`).
	let grantsSummary = $derived.by(() => {
		const g = data.extension.grantedPermissions;
		if (!g) return [];
		return Object.entries(g)
			.filter(([k]) => k !== "grantedAt")
			.map(([k, v]) => ({ key: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) }));
	});
</script>

<svelte:head>
	<title>Audit · {data.extension.name}</title>
</svelte:head>

<div class="flex flex-col gap-6 lg:flex-row">
	<!-- Main column -->
	<div class="flex-1 space-y-4">
		<!-- Header -->
		<div class="flex items-center gap-3">
			<a
				href={`/extensions/${data.extension.id}`}
				class="text-sm text-blue-400 hover:text-blue-300"
			>
				&larr; {data.extension.name}
			</a>
			<h1 class="text-xl font-semibold text-[var(--color-text-primary)]">
				Audit
			</h1>
			<span class="text-xs text-[var(--color-text-muted)]">v{data.extension.version}</span>
		</div>

		<!-- Filter pills -->
		<div class="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Audit filters">
			{#each FILTERS as f}
				<button
					data-testid={`audit-filter-${f.id}`}
					onclick={() => selectFilter(f.id)}
					class="rounded-full border px-3 py-1 text-xs font-medium transition-colors {activeFilter === f.id ? 'border-blue-500 bg-blue-600 text-white' : 'border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
				>
					<span class="mr-1">{f.icon}</span>{f.label}
				</button>
			{/each}

			<div class="ml-auto flex items-center gap-2 text-xs">
				<label class="flex items-center gap-1 text-[var(--color-text-secondary)]">
					From
					<input
						type="datetime-local"
						bind:value={sinceInput}
						onchange={() => applyFilters()}
						class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[var(--color-text-primary)]"
					/>
				</label>
				<label class="flex items-center gap-1 text-[var(--color-text-secondary)]">
					To
					<input
						type="datetime-local"
						bind:value={untilInput}
						onchange={() => applyFilters()}
						class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[var(--color-text-primary)]"
					/>
				</label>
			</div>
		</div>

		<!-- Timeline -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]" data-testid="audit-timeline">
			{#if entries.length === 0}
				<div class="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
					{loading ? "Loading…" : "No audit entries match the current filters."}
				</div>
			{:else}
				<ul class="divide-y divide-[var(--color-border)]">
					{#each entries as entry (entry.id)}
						<li class="px-4 py-3 text-sm" data-testid="audit-row" data-entry-kind={entry.kind} data-entry-id={entry.id}>
							<button
								onclick={() => toggleExpand(entry.id)}
								class="flex w-full items-start gap-3 text-left"
							>
								<span class="mt-0.5 text-base">{entryIcon(entry)}</span>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="font-medium text-[var(--color-text-primary)]">{entryLabel(entry)}</span>
										{#if entry.kind === "capability" && !entry.success}
											<span class="rounded-full bg-red-900/40 px-1.5 py-0.5 text-[10px] font-medium text-red-300">denied</span>
										{/if}
									</div>
									<p class="truncate text-xs text-[var(--color-text-secondary)]">{entrySummary(entry)}</p>
								</div>
								<div class="text-right text-xs text-[var(--color-text-muted)]">
									{#if entry.kind === "capability"}
										<div>{entry.durationMs}ms</div>
										{#if entry.costUsd != null}<div>{fmtUsd(entry.costUsd)}</div>{/if}
									{/if}
									<div class="whitespace-nowrap">{fmtDate(entry.createdAt)}</div>
								</div>
							</button>

							{#if expandedId === entry.id}
								<div class="mt-2 space-y-2 rounded bg-[var(--color-surface)] p-3 text-xs" data-testid="audit-row-detail">
									{#if entry.kind === "capability"}
										{#if entry.errorMessage}
											<div>
												<span class="font-medium text-red-300">Error:</span>
												<span class="text-[var(--color-text-secondary)]">{entry.errorCode ?? ""} {entry.errorMessage}</span>
											</div>
										{/if}
										{#if entry.before !== null && entry.before !== undefined}
											<div>
												<div class="font-medium text-[var(--color-text-secondary)]">Before (redacted)</div>
												<pre class="mt-1 max-h-40 overflow-auto rounded bg-[var(--color-surface-tertiary)] p-2 text-[var(--color-text-primary)]">{JSON.stringify(entry.before, null, 2)}</pre>
											</div>
										{/if}
										{#if entry.after !== null && entry.after !== undefined}
											<div>
												<div class="font-medium text-[var(--color-text-secondary)]">After (redacted)</div>
												<pre class="mt-1 max-h-40 overflow-auto rounded bg-[var(--color-surface-tertiary)] p-2 text-[var(--color-text-primary)]">{JSON.stringify(entry.after, null, 2)}</pre>
											</div>
										{/if}
									{:else if entry.kind === "resource"}
										{#if entry.previousBody}
											<div>
												<div class="font-medium text-[var(--color-text-secondary)]">Previous</div>
												<pre class="mt-1 max-h-40 overflow-auto rounded bg-[var(--color-surface-tertiary)] p-2 text-[var(--color-text-primary)]">{entry.previousBody}</pre>
											</div>
										{/if}
										{#if entry.newBody}
											<div>
												<div class="font-medium text-[var(--color-text-secondary)]">New</div>
												<pre class="mt-1 max-h-40 overflow-auto rounded bg-[var(--color-surface-tertiary)] p-2 text-[var(--color-text-primary)]">{entry.newBody}</pre>
											</div>
										{/if}
									{:else}
										<pre class="max-h-40 overflow-auto rounded bg-[var(--color-surface-tertiary)] p-2 text-[var(--color-text-primary)]">{JSON.stringify(entry.metadata ?? {}, null, 2)}</pre>
									{/if}
								</div>
							{/if}
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
					>
						{loading ? "Loading…" : "Load more"}
					</button>
				</div>
			{/if}
		</div>
	</div>

	<!-- Right rail -->
	<aside class="w-full space-y-4 lg:w-80">
		<!-- Stats strip -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4" data-testid="audit-stats">
			<h2 class="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Last 24 hours</h2>
			<dl class="grid grid-cols-2 gap-3 text-xs">
				<div>
					<dt class="text-[var(--color-text-muted)]">Calls</dt>
					<dd class="text-base font-semibold text-[var(--color-text-primary)]" data-testid="audit-stats-total">{stats.totalCalls}</dd>
				</div>
				<div>
					<dt class="text-[var(--color-text-muted)]">Denials</dt>
					<dd class="text-base font-semibold {stats.denialCount > 0 ? 'text-red-400' : 'text-[var(--color-text-primary)]'}" data-testid="audit-stats-denials">{stats.denialCount}</dd>
				</div>
				<div>
					<dt class="text-[var(--color-text-muted)]">Cost</dt>
					<dd class="text-base font-semibold text-[var(--color-text-primary)]" data-testid="audit-stats-cost">{fmtUsd(stats.totalCostUsd)}</dd>
				</div>
				<div>
					<dt class="text-[var(--color-text-muted)]">Success</dt>
					<dd class="text-base font-semibold text-[var(--color-text-primary)]" data-testid="audit-stats-success">{fmtPercent(stats.successRate)}</dd>
				</div>
			</dl>
			<p class="mt-3 text-[10px] text-[var(--color-text-muted)]">
				Cost is approximate; provider billing may differ.
			</p>
		</div>

		<!-- Granted permissions snapshot -->
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4" data-testid="audit-grants">
			<h2 class="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">Current grants</h2>
			{#if grantsSummary.length === 0}
				<p class="text-xs text-[var(--color-text-muted)]">No permissions granted.</p>
			{:else}
				<ul class="space-y-1.5 text-xs">
					{#each grantsSummary as g (g.key)}
						<li>
							<code class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[var(--color-text-primary)]">{g.key}</code>
							<span class="ml-1 break-all text-[var(--color-text-secondary)]">{g.value}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</aside>
</div>
