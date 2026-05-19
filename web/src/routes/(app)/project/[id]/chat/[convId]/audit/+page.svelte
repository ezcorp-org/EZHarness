<script lang="ts">
	/**
	 * Phase 52.3 — per-conversation audit drill-down.
	 *
	 * Vertical timeline aligned to the message stream: for each
	 * user/assistant turn, we show the capability calls that fired
	 * BETWEEN that turn and the next. Helps debug "why did the
	 * assistant suddenly behave differently in turn 7" by showing
	 * exactly what context an extension fed it.
	 *
	 * Data shape: messages are sorted by createdAt ASC (chat order);
	 * audit entries by createdAt DESC from the loader. We group
	 * `entries` by the message that immediately precedes them, so
	 * each "turn block" has its message header + zero-or-more pills.
	 */
	import type { PageData } from "./$types";
	import { bucketEntriesByMessage } from "$lib/audit/conversation-buckets";

	const { data }: { data: PageData } = $props();

	type Entry = (typeof data.entries)[number];

	const buckets = $derived(bucketEntriesByMessage(data.messages, data.entries));

	// Per-extension chip counts — sum capability rows by their
	// extensionId (when known). The merger only carries extensionId
	// indirectly (via on_behalf_of for capability rows) — for the
	// chips we'd need a denormalized field. As a v1.3 floor we
	// derive a per-capability count from the entries we already
	// have.
	const chipBuckets = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const e of data.entries) {
			if (e.kind === "capability") {
				counts.set(e.capability, (counts.get(e.capability) ?? 0) + 1);
			}
		}
		return Array.from(counts, ([cap, n]) => ({ cap, n }));
	});

	function fmtTime(d: string | Date): string {
		const date = typeof d === "string" ? new Date(d) : d;
		return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}

	function pillIcon(entry: Entry): string {
		if (entry.kind === "governance") return "⚙️";
		if (entry.kind === "resource") return entry.resourceKind === "memory" ? "🧠" : "📚";
		if (!entry.success) return "🚫";
		const cap = entry.capability;
		if (cap === "llm") return "🤖";
		if (cap === "memory") return "🧠";
		if (cap === "lessons") return "📚";
		if (cap === "schedule") return "📅";
		if (cap === "events") return "📡";
		return "·";
	}

	function pillLabel(entry: Entry): string {
		if (entry.kind === "governance") return entry.action;
		if (entry.kind === "resource") return `${entry.resourceKind}.${entry.action}`;
		return `${entry.capability}.${entry.action}`;
	}

	function pillSummary(entry: Entry): string {
		if (entry.kind === "capability") {
			const bits: string[] = [];
			if (entry.tokensUsed != null) bits.push(`${(entry.tokensUsed / 1000).toFixed(1)}k tok`);
			if (entry.costUsd != null) bits.push(`$${entry.costUsd.toFixed(3)}`);
			if (entry.model) bits.push(entry.model);
			bits.push(`${entry.durationMs}ms`);
			return bits.join(" · ");
		}
		if (entry.kind === "resource") {
			return entry.resourceId.slice(0, 12);
		}
		return entry.action;
	}
</script>

<svelte:head>
	<title>Audit · {data.conversation.title}</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center gap-3">
		<a
			href={`/project/${data.conversation.projectId}/chat/${data.conversation.id}`}
			class="text-sm text-blue-400 hover:text-blue-300"
		>
			&larr; Back to chat
		</a>
		<h1 class="text-xl font-semibold text-[var(--color-text-primary)]">
			Audit · {data.conversation.title}
		</h1>
	</div>

	<!-- Per-capability chips — quick spend overview. -->
	{#if chipBuckets.length > 0}
		<div class="flex flex-wrap gap-2" data-testid="audit-conv-chips">
			{#each chipBuckets as c (c.cap)}
				<span class="rounded-full bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs text-[var(--color-text-secondary)]">
					{c.cap} · {c.n} call{c.n === 1 ? "" : "s"}
				</span>
			{/each}
		</div>
	{/if}

	<!-- Timeline aligned to the message stream. -->
	<div class="space-y-4" data-testid="audit-conv-timeline">
		{#if buckets.beforeFirst.length > 0}
			<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
				<h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
					Before first turn
				</h2>
				<div class="space-y-1.5" data-testid="audit-conv-bucket-before-first">
					{#each buckets.beforeFirst as entry (entry.id)}
						<div class="flex items-center gap-2 rounded-md bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs" data-testid="audit-conv-pill" data-entry-kind={entry.kind}>
							<span>{pillIcon(entry)}</span>
							<span class="font-medium text-[var(--color-text-primary)]">{pillLabel(entry)}</span>
							<span class="text-[var(--color-text-muted)]">{pillSummary(entry)}</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#each buckets.sortedMessages as msg (msg.id)}
			{@const bucket = buckets.byMessage.get(msg.id) ?? []}
			<section
				class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3"
				data-testid="audit-conv-bucket"
				data-message-id={msg.id}
				data-bucket-size={bucket.length}
			>
				<header class="mb-2 flex items-center gap-2 text-xs">
					<span class="rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 font-medium text-[var(--color-text-secondary)]">
						{msg.role}
					</span>
					<span class="text-[var(--color-text-muted)]">{fmtTime(msg.createdAt)}</span>
					<span class="truncate text-[var(--color-text-muted)]">{msg.contentPreview}</span>
				</header>
				{#if bucket.length === 0}
					<p class="text-xs text-[var(--color-text-muted)] italic">No capability calls during this turn.</p>
				{:else}
					<div class="space-y-1.5">
						{#each bucket as entry (entry.id)}
							<div class="flex items-center gap-2 rounded-md bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs" data-testid="audit-conv-pill" data-entry-kind={entry.kind}>
								<span>{pillIcon(entry)}</span>
								<span class="font-medium text-[var(--color-text-primary)]">{pillLabel(entry)}</span>
								<span class="text-[var(--color-text-muted)]">{pillSummary(entry)}</span>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/each}
	</div>
</div>
