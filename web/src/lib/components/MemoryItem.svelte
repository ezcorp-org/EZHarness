<script module lang="ts">
	export interface Provenance {
		sourceConversationId?: string;
		sourceMessageIds?: string[];
		extractedAt?: string;
		confidence?: string;
		history?: Array<{
			action: string;
			timestamp: string;
			reason: string;
			previousContent?: string;
		}>;
	}

	export interface Memory {
		id: string;
		content: string;
		category: string;
		confidence: string;
		status: string;
		projectId: string | null;
		projectIds?: string[];
		conversationId: string | null;
		messageIds: string[] | null;
		provenance: Provenance | null;
		lastAccessedAt: string;
		createdAt: string;
		updatedAt: string;
		/** v1.4: when false, this memory is suppressed from LLM
		 *  system-prompt injection (the gate lives in
		 *  `src/extensions/memory-handler.ts` from Phase 51). The
		 *  curation tab surfaces a per-row toggle so users can flip
		 *  this without touching PGlite directly. Always populated
		 *  by the API (column is `notNull` with default `true`). */
		injectionEligible: boolean;
	}
</script>

<script lang="ts">
	import ProjectPicker from "./ProjectPicker.svelte";

	let {
		memory,
		focusMemoryId,
		onupdated,
		ondeleted,
	}: {
		memory: Memory;
		focusMemoryId?: string;
		onupdated: (m: Memory) => void;
		ondeleted: (id: string) => void;
	} = $props();

	let expanded = $state(false);
	let editing = $state(false);
	let advancedOpen = $state(false);
	let rootEl: HTMLDivElement | undefined = $state();

	// When this item is the one being focused via ?focus= on the memories page,
	// auto-expand and scroll it into view. Re-applies whenever the focus prop
	// actually changes — so navigating away and back to the same memory works too.
	let lastSeenFocus: string | undefined;
	$effect(() => {
		const current = focusMemoryId;
		if (current !== lastSeenFocus) {
			lastSeenFocus = current;
			if (current && current === memory.id) {
				expanded = true;
				// Defer until after expansion renders.
				requestAnimationFrame(() => {
					rootEl?.scrollIntoView({ behavior: "smooth", block: "center" });
				});
			}
		}
	});

	// Edit state
	let editContent = $state("");
	let editCategory = $state("");
	let editConfidence = $state("");
	let editProjectIds = $state<string[]>([]);

	// Delete confirmation state
	let deleteConfirming = $state(false);
	let deleteTimer: ReturnType<typeof setTimeout> | undefined;

	const categoryColors: Record<string, string> = {
		preferences: "bg-blue-500/20 text-blue-300",
		technical: "bg-green-500/20 text-green-300",
		biographical: "bg-purple-500/20 text-purple-300",
		decisions_goals: "bg-amber-500/20 text-amber-300",
	};

	const categoryLabels: Record<string, string> = {
		preferences: "Preferences",
		technical: "Technical",
		biographical: "Biographical",
		decisions_goals: "Decisions & Goals",
	};

	const statusDots: Record<string, string> = {
		active: "bg-green-500",
		stale: "bg-yellow-500",
		archived: "bg-gray-500",
	};

	function relativeTime(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return "just now";
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		if (months < 12) return `${months}mo ago`;
		return `${Math.floor(months / 12)}y ago`;
	}

	function startEdit() {
		editContent = memory.content;
		editCategory = memory.category;
		editConfidence = memory.confidence;
		editProjectIds = memory.projectIds ?? [];
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		advancedOpen = false;
	}

	async function saveEdit() {
		const body: Record<string, unknown> = {};
		if (editContent !== memory.content) body.content = editContent;
		if (editCategory !== memory.category) body.category = editCategory;
		if (editConfidence !== memory.confidence) body.confidence = editConfidence;

		const prevIds = memory.projectIds ?? [];
		if (JSON.stringify(editProjectIds.slice().sort()) !== JSON.stringify(prevIds.slice().sort())) {
			body.projectIds = editProjectIds;
		}

		if (Object.keys(body).length === 0) {
			cancelEdit();
			return;
		}

		try {
			const res = await fetch(`/api/memories/${memory.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (res.ok) {
				const updated = await res.json();
				onupdated(updated);
			}
		} catch {
			// silent
		}
		editing = false;
		advancedOpen = false;
	}

	function handleDelete() {
		if (deleteConfirming) {
			clearTimeout(deleteTimer);
			deleteConfirming = false;
			performDelete();
		} else {
			deleteConfirming = true;
			deleteTimer = setTimeout(() => {
				deleteConfirming = false;
			}, 3000);
		}
	}

	async function performDelete() {
		try {
			const res = await fetch(`/api/memories/${memory.id}`, { method: "DELETE" });
			if (res.ok || res.status === 204) {
				ondeleted(memory.id);
			}
		} catch {
			// silent
		}
	}

	async function changeStatus(newStatus: string) {
		try {
			const res = await fetch(`/api/memories/${memory.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: newStatus }),
			});
			if (res.ok) {
				const updated = await res.json();
				onupdated(updated);
			}
		} catch {
			// silent
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={rootEl}
	class="rounded-lg border bg-[var(--color-surface-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)] {focusMemoryId === memory.id ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/40' : 'border-[var(--color-border)]'}"
>
	<!-- Collapsed row -->
	<div
		class="flex cursor-pointer items-center gap-3 px-4 py-3"
		onclick={() => { if (!editing) expanded = !expanded; }}
	>
		<!-- Status dot -->
		<span
			class="h-2 w-2 shrink-0 rounded-full {statusDots[memory.status] ?? 'bg-gray-500'}"
			title={memory.status}
		></span>

		<!-- Content preview -->
		<span class="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]">
			{memory.content.slice(0, 100)}{memory.content.length > 100 ? "..." : ""}
		</span>

		<!-- Category badge -->
		<span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium {categoryColors[memory.category] ?? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">
			{categoryLabels[memory.category] ?? memory.category}
		</span>

		<!-- Scope badge -->
		<span class="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium {(memory.projectIds?.length ?? 0) > 0 ? 'bg-slate-500/20 text-slate-300' : 'bg-cyan-500/20 text-cyan-300'}">
			{#if (memory.projectIds?.length ?? 0) > 0}
				<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
				{memory.projectIds!.length === 1 ? "1 project" : `${memory.projectIds!.length} projects`}
			{:else}
				<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
				Org-wide
			{/if}
		</span>

		<!-- Confidence -->
		<span class="shrink-0 text-[10px] text-[var(--color-text-muted)]">{memory.confidence}</span>

		<!-- Age -->
		<span class="shrink-0 text-[10px] text-[var(--color-text-muted)]">{relativeTime(memory.updatedAt)}</span>

		<!-- Expand indicator -->
		<svg
			class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
			fill="none" stroke="currentColor" viewBox="0 0 24 24"
		>
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</div>

	<!-- Expanded content -->
	{#if expanded}
		<div class="border-t border-[var(--color-border)] px-4 py-3">
			{#if editing}
				<!-- Edit mode -->
				<textarea
					bind:value={editContent}
					class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
					rows="4"
				></textarea>

				<!-- Advanced section -->
				<button
					onclick={() => (advancedOpen = !advancedOpen)}
					class="mt-2 flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
				>
					<svg
						class="h-3 w-3 transition-transform {advancedOpen ? 'rotate-90' : ''}"
						fill="none" stroke="currentColor" viewBox="0 0 24 24"
					>
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
					</svg>
					Advanced: Change category and confidence
				</button>

				{#if advancedOpen}
					<div class="mt-2 flex flex-wrap gap-4">
						<label class="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
							Category
							<select
								bind:value={editCategory}
								class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
							>
								<option value="preferences">Preferences</option>
								<option value="biographical">Biographical</option>
								<option value="technical">Technical</option>
								<option value="decisions_goals">Decisions & Goals</option>
							</select>
						</label>
						<label class="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
							Confidence
							<select
								bind:value={editConfidence}
								class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
							>
								<option value="high">High</option>
								<option value="medium">Medium</option>
								<option value="low">Low</option>
							</select>
						</label>
						<div class="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
							Scope
							<ProjectPicker
								selectedIds={editProjectIds}
								onchange={(ids) => { editProjectIds = ids; }}
							/>
						</div>
					</div>
				{/if}

				<div class="mt-3 flex gap-2">
					<button
						onclick={saveEdit}
						class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500"
					>
						Save
					</button>
					<button
						onclick={cancelEdit}
						class="rounded bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
					>
						Cancel
					</button>
				</div>
			{:else}
				<!-- View mode -->
				<p class="whitespace-pre-wrap text-sm text-[var(--color-text-primary)]">{memory.content}</p>

				<!-- Provenance -->
				{#if memory.provenance}
					{@const prov = memory.provenance}
					<div class="mt-3 border-t border-[var(--color-border)] pt-3">
						<h4 class="mb-1 text-xs font-medium text-[var(--color-text-secondary)]">Provenance</h4>
						{#if prov.sourceConversationId}
							<p class="text-xs text-[var(--color-text-muted)]">
								Source conversation: <span class="text-[var(--color-text-secondary)]">{prov.sourceConversationId}</span>
							</p>
						{/if}
						{#if prov.extractedAt}
							<p class="text-xs text-[var(--color-text-muted)]">
								Extracted: <span class="text-[var(--color-text-secondary)]">{new Date(prov.extractedAt).toLocaleDateString()}</span>
							</p>
						{/if}
						{#if prov.sourceMessageIds?.length}
							<p class="text-xs text-[var(--color-text-muted)]">
								Messages: <span class="text-[var(--color-text-secondary)]">{prov.sourceMessageIds.length}</span>
							</p>
						{/if}
					</div>
				{/if}

				<!-- Audit history -->
				{#if memory.provenance?.history?.length}
					<div class="mt-3 border-t border-[var(--color-border)] pt-3">
						<h4 class="mb-1 text-xs font-medium text-[var(--color-text-secondary)]">History</h4>
						<div class="flex flex-col gap-1">
							{#each memory.provenance.history as entry}
								<div class="text-xs text-[var(--color-text-muted)]">
									<span class="text-[var(--color-text-secondary)]">{entry.action}</span>
									{entry.reason ? ` - ${entry.reason}` : ""}
									<span class="ml-1 text-[var(--color-text-muted)]">{new Date(entry.timestamp).toLocaleDateString()}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Confidence display -->
				<div class="mt-3 border-t border-[var(--color-border)] pt-3">
					<span class="text-xs text-[var(--color-text-muted)]">Confidence: <span class="text-[var(--color-text-secondary)]">{memory.confidence}</span></span>
					<span class="ml-3 text-xs text-[var(--color-text-muted)]">Status: <span class="text-[var(--color-text-secondary)]">{memory.status}</span></span>
					<span class="ml-3 text-xs text-[var(--color-text-muted)]">Updated: <span class="text-[var(--color-text-secondary)]">{relativeTime(memory.updatedAt)}</span></span>
				</div>

				<!-- Actions -->
				<div class="mt-3 flex gap-2">
					<button
						onclick={startEdit}
						class="rounded bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
					>
						Edit
					</button>

					{#if memory.status === "stale" || memory.status === "archived"}
						<button
							onclick={() => changeStatus("active")}
							class="rounded bg-green-700/50 px-3 py-1 text-xs font-medium text-green-300 hover:bg-green-700"
						>
							Reactivate
						</button>
					{/if}

					{#if memory.status === "active"}
						<button
							onclick={() => changeStatus("archived")}
							class="rounded bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
						>
							Archive
						</button>
					{/if}

					<button
						onclick={handleDelete}
						class="rounded px-3 py-1 text-xs font-medium transition-colors
							{deleteConfirming
							? 'bg-red-600 text-white hover:bg-red-500'
							: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
					>
						{deleteConfirming ? "Confirm Delete?" : "Delete"}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
