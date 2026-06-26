<!--
  HubComponentRenderer — recursive renderer for the Hub's declarative
  page component tree ($lib/hub PageNode vocabulary).

  Security posture: every node arrives ALREADY validated server-side
  (src/extensions/page-schema.ts). Rendering is text-only interpolation
  — the SOLE `{@html}` is the markdown node, routed through the
  existing `renderMarkdown` + DOMPurify pipeline. hrefs are re-checked
  with `isSafeInternalHref` as defense-in-depth. Actions are dispatched
  via the `onAction` callback prop; confirm dialogs are rendered by the
  HOST page (never by extension content).
-->
<script lang="ts">
	import HubComponentRenderer from "./HubComponentRenderer.svelte";
	import { renderMarkdown } from "$lib/markdown.js";
	import { isSafeInternalHref, type PageAction, type PageNode } from "$lib/hub";

	let {
		nodes,
		onAction,
	}: {
		nodes: PageNode[];
		onAction?: (action: PageAction) => void;
	} = $props();

	function dispatch(action: PageAction | undefined) {
		if (action && onAction) onAction(action);
	}

	// ── Sibling layout grouping ──────────────────────────────────────
	// The page tree is a FLAT node list; the host stacks siblings with
	// `space-y-*` vertical rhythm. Adjacent inline action nodes (button,
	// link) would otherwise jam together with no horizontal gap. We fold
	// each run of consecutive button/link siblings into ONE flex group so
	// they lay out in a wrapping row with a consistent gap, while every
	// other node renders standalone (one flow child, normal rhythm).
	type RenderGroup =
		| { kind: "actions"; nodes: PageNode[] }
		| { kind: "single"; node: PageNode };

	function isActionNode(node: PageNode): boolean {
		return node.type === "button" || node.type === "link";
	}

	const groups = $derived.by<RenderGroup[]>(() => {
		const out: RenderGroup[] = [];
		for (const node of nodes) {
			if (isActionNode(node)) {
				const last = out[out.length - 1];
				if (last?.kind === "actions") last.nodes.push(node);
				else out.push({ kind: "actions", nodes: [node] });
			} else {
				out.push({ kind: "single", node });
			}
		}
		return out;
	});

	// ── Style maps (mirrors ExtensionPanel.svelte; Phase 3 unifies) ──

	function badgeColorClass(color?: string): string {
		switch (color) {
			case "blue":   return "bg-blue-500/20 text-blue-300";
			case "green":  return "bg-green-500/20 text-green-300";
			case "red":    return "bg-red-500/20 text-red-300";
			case "yellow": return "bg-yellow-500/20 text-yellow-300";
			case "purple": return "bg-purple-500/20 text-purple-300";
			default:       return "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]";
		}
	}

	function statusDotClass(s: string): string {
		switch (s) {
			case "running": return "bg-blue-400 animate-pulse";
			case "success": return "bg-green-500";
			case "error":   return "bg-red-500";
			case "warning": return "bg-yellow-500";
			default:        return "bg-[var(--color-surface-tertiary)] border border-[var(--color-border)]";
		}
	}

	function listStatusIcon(s?: string): string {
		switch (s) {
			case "active":    return "▶";
			case "completed": return "✓";
			case "failed":    return "✗";
			default:          return "○";
		}
	}

	function listStatusColor(s?: string): string {
		switch (s) {
			case "active":    return "text-blue-400";
			case "completed": return "text-green-400";
			case "failed":    return "text-red-400";
			default:          return "text-[var(--color-text-muted)]";
		}
	}

	function textVariantClass(v?: string): string {
		switch (v) {
			case "muted":    return "text-[var(--color-text-muted)]";
			case "emphasis": return "text-[var(--color-text-primary)] font-medium";
			default:         return "text-[var(--color-text-secondary)]";
		}
	}

	function buttonStyleClass(style?: string): string {
		switch (style) {
			case "danger":
				return "bg-red-600/90 text-white hover:bg-red-600";
			case "secondary":
				return "border border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]";
			default:
				return "bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:opacity-90";
		}
	}
</script>

{#snippet renderNode(node: PageNode)}
	{#if node.type === "section"}
		<section class="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]/50 p-4" data-testid="hub-node-section">
			{#if node.title}
				<h3 class="break-words text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{node.title}</h3>
			{/if}
			<HubComponentRenderer nodes={node.nodes} {onAction} />
		</section>

	{:else if node.type === "heading"}
		{#if node.level === 1}
			<h1 class="break-words text-xl font-bold text-[var(--color-text-primary)] [overflow-wrap:anywhere]" data-testid="hub-node-heading">{node.text}</h1>
		{:else if node.level === 2}
			<h2 class="break-words text-lg font-semibold text-[var(--color-text-primary)] [overflow-wrap:anywhere]" data-testid="hub-node-heading">{node.text}</h2>
		{:else}
			<h3 class="break-words text-sm font-semibold text-[var(--color-text-primary)] [overflow-wrap:anywhere]" data-testid="hub-node-heading">{node.text}</h3>
		{/if}

	{:else if node.type === "markdown"}
		<!-- The ONLY {@html} in the Hub: server-validated content through
		     the shared DOMPurify pipeline. The `[&_pre]`/`[&_code]` child
		     variants compile to descendant rules that DO reach the {@html}
		     content and are scoped to THIS Hub node only — long command
		     previews (`mv "/app/projects/…"`) wrap inside the card instead
		     of overflowing. Global `prose-chat`/chat code styling is
		     untouched. -->
		<div class="prose-chat break-words text-sm text-[var(--color-text-secondary)] [overflow-wrap:anywhere] [&_code]:break-words [&_code]:[overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:[overflow-wrap:anywhere]" data-testid="hub-node-markdown">
			{@html renderMarkdown(node.content)}
		</div>

	{:else if node.type === "stats"}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="hub-node-stats">
			{#each node.items as item}
				<div class="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
					<div class="break-words text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{item.label}</div>
					<div class="mt-1 break-words text-base font-semibold tabular-nums text-[var(--color-text-primary)] [overflow-wrap:anywhere]">{item.value}</div>
					{#if item.hint}
						<div class="break-words text-[10px] text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{item.hint}</div>
					{/if}
				</div>
			{/each}
		</div>

	{:else if node.type === "table"}
		<div class="overflow-x-auto rounded-lg border border-[var(--color-border)]" data-testid="hub-node-table">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
						{#each node.columns as column}
							<th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">{column}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each node.rows as row}
						{@const safeHref = row.href !== undefined && isSafeInternalHref(row.href) ? row.href : undefined}
						<tr
							class="border-b border-[var(--color-border)] last:border-b-0 {row.action || safeHref ? 'cursor-pointer hover:bg-[var(--color-surface-tertiary)]/60' : ''}"
							data-testid="hub-table-row"
							onclick={() => {
								if (row.action) dispatch(row.action);
							}}
						>
							{#each row.cells as cell, cellIdx}
								<td class="break-words px-3 py-2 text-xs text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
									{#if safeHref && cellIdx === 0}
										<!-- A row may carry BOTH href and action: the anchor must not
										          bubble to the tr onclick, or the action fires mid-navigation. -->
										<a
											href={safeHref}
											class="text-[var(--color-accent)] hover:underline"
											data-testid="hub-row-link"
											onclick={(e) => e.stopPropagation()}>{cell}</a>
									{:else}
										{cell}
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

	{:else if node.type === "button"}
		<button
			type="button"
			class="break-words rounded-lg px-3 py-1.5 text-sm font-medium transition-colors [overflow-wrap:anywhere] {buttonStyleClass(node.style)}"
			data-testid="hub-node-button"
			onclick={() => dispatch(node.action)}
		>
			{node.label}
		</button>

	{:else if node.type === "link"}
		{#if isSafeInternalHref(node.href)}
			<a href={node.href} class="break-words text-sm text-[var(--color-accent)] hover:underline [overflow-wrap:anywhere]" data-testid="hub-node-link">{node.label}</a>
		{/if}

	{:else if node.type === "empty-state"}
		<div class="flex flex-col items-center py-8 text-center" data-testid="hub-node-empty-state">
			<h3 class="break-words text-sm font-semibold text-[var(--color-text-primary)] [overflow-wrap:anywhere]">{node.title}</h3>
			{#if node.detail}
				<p class="mt-1 break-words text-xs text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{node.detail}</p>
			{/if}
		</div>

	{:else if node.type === "header"}
		<div class="min-w-0" data-testid="hub-node-header">
			<div class="break-words text-sm font-semibold text-[var(--color-text-primary)] [overflow-wrap:anywhere]">{node.title}</div>
			{#if node.subtitle}
				<div class="break-words text-xs text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{node.subtitle}</div>
			{/if}
		</div>

	{:else if node.type === "text"}
		<p class="break-words text-sm leading-relaxed [overflow-wrap:anywhere] {textVariantClass(node.variant)}" data-testid="hub-node-text">{node.content}</p>

	{:else if node.type === "badge"}
		<span class="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium {badgeColorClass(node.color)}" data-testid="hub-node-badge">{node.label}</span>

	{:else if node.type === "progress"}
		<div data-testid="hub-node-progress">
			{#if node.label}
				<div class="mb-0.5 flex items-center justify-between gap-2">
					<span class="min-w-0 break-words text-[10px] text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{node.label}</span>
					<span class="shrink-0 text-[10px] tabular-nums text-[var(--color-text-secondary)]">{Math.round(node.value)}%</span>
				</div>
			{/if}
			<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-tertiary)]">
				<div class="h-full rounded-full bg-blue-500 transition-all duration-300" style:width="{node.value}%"></div>
			</div>
		</div>

	{:else if node.type === "status"}
		<div class="flex items-start gap-2" data-testid="hub-node-status">
			<span class="mt-1.5 h-2 w-2 shrink-0 rounded-full {statusDotClass(node.state)}"></span>
			<span class="min-w-0 break-words text-sm text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">{node.label}</span>
		</div>

	{:else if node.type === "list"}
		<div class="space-y-0.5" data-testid="hub-node-list">
			{#each node.items as item}
				<div class="flex items-start gap-2 py-0.5">
					{#if item.status != null}
						<span class="mt-0.5 shrink-0 text-[10px] leading-none {listStatusColor(item.status)}">{listStatusIcon(item.status)}</span>
					{/if}
					<div class="min-w-0 flex-1">
						<span class="break-words text-sm text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">{item.label}</span>
						{#if item.badge}
							<span class="ml-1 inline-block rounded-full px-1.5 py-0.5 text-[9px] font-medium {badgeColorClass(item.badgeColor)}">{item.badge}</span>
						{/if}
						{#if item.detail}
							<div class="break-words text-[10px] text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{item.detail}</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

	{:else if node.type === "kv"}
		<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="hub-node-kv">
			{#each node.pairs as pair}
				<span class="min-w-0 break-words text-xs font-medium text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{pair.key}</span>
				<span class="min-w-0 break-words text-xs text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">{pair.value}</span>
			{/each}
		</div>

	{:else if node.type === "counter"}
		<div data-testid="hub-node-counter">
			<div class="flex items-center justify-between gap-2">
				<span class="min-w-0 break-words text-sm text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">{node.label}</span>
				<span class="shrink-0 text-sm tabular-nums text-[var(--color-text-primary)]">
					{node.value}{#if node.total != null}/{node.total}{/if}
				</span>
			</div>
			{#if node.total != null && node.total > 0}
				<div class="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-tertiary)]">
					<div class="h-full rounded-full bg-blue-500 transition-all duration-300" style:width="{Math.min(100, (node.value / node.total) * 100)}%"></div>
				</div>
			{/if}
		</div>

	{:else if node.type === "divider"}
		<hr class="border-[var(--color-border)]" data-testid="hub-node-divider" />
	{/if}
{/snippet}

{#each groups as group}
	{#if group.kind === "actions"}
		<!-- A run of adjacent button/link siblings lays out as ONE wrapping
		     flex row so they get a consistent gap and never jam together or
		     overflow on narrow widths. -->
		<div class="flex flex-wrap items-center gap-2">
			{#each group.nodes as node}
				{@render renderNode(node)}
			{/each}
		</div>
	{:else}
		{@render renderNode(group.node)}
	{/if}
{/each}
