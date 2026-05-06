<script lang="ts">
	import { untrack } from "svelte";
	import { slide } from "svelte/transition";
	import { readExtPanel, writeExtPanel } from "$lib/panel-persistence.js";

	// ── Panel Component Types (mirrored from src/extensions/types.ts) ──
	// Inlined here because the frontend can't easily import from src/.

	type PanelComponentType = "header" | "text" | "badge" | "progress" | "status" | "list" | "kv" | "counter" | "divider";
	type BadgeColor = "blue" | "green" | "red" | "yellow" | "purple" | "gray";
	type StatusState = "idle" | "running" | "success" | "error" | "warning";
	type ListItemStatus = "pending" | "active" | "completed" | "failed";
	type TextVariant = "muted" | "default" | "emphasis";

	interface PanelHeader { type: "header"; title: string; subtitle?: string; }
	interface PanelText { type: "text"; content: string; variant?: TextVariant; }
	interface PanelBadge { type: "badge"; label: string; color?: BadgeColor; }
	interface PanelProgress { type: "progress"; value: number; label?: string; }
	interface PanelStatus { type: "status"; label: string; state: StatusState; }
	interface PanelListItem { label: string; status?: ListItemStatus; detail?: string; badge?: string; badgeColor?: BadgeColor; }
	interface PanelList { type: "list"; items: PanelListItem[]; }
	interface PanelKV { type: "kv"; pairs: { key: string; value: string }[]; }
	interface PanelCounter { type: "counter"; label: string; value: number; total?: number; }
	interface PanelDivider { type: "divider"; }
	type PanelComponent = PanelHeader | PanelText | PanelBadge | PanelProgress | PanelStatus | PanelList | PanelKV | PanelCounter | PanelDivider;

	interface ExtensionPanelState {
		title: string;
		collapsed?: boolean;
		components: PanelComponent[];
	}

	// ── Props ──

	let {
		extensionId,
		extensionName,
		conversationId,
		state: extState,
	}: {
		extensionId: string;
		extensionName: string;
		conversationId: string;
		state: Record<string, unknown>;
	} = $props();

	// ── Validate state as ExtensionPanelState ──

	let panelState = $derived.by((): ExtensionPanelState | null => {
		if (!extState || typeof extState !== "object") return null;
		if (typeof extState.title !== "string") return null;
		if (!Array.isArray(extState.components)) return null;
		return extState as unknown as ExtensionPanelState;
	});

	let expanded = $state(untrack(() => readExtPanel(conversationId, extensionId)?.expanded ?? true));
	let componentCount = $derived(panelState?.components.length ?? 0);

	// Persist `expanded` state per conversation+extension so a refresh
	// preserves the user's last toggle. The initial write echoes the
	// already-stored value, which is harmless.
	$effect(() => {
		writeExtPanel(conversationId, extensionId, { expanded });
	});

	// ── Badge color mapping ──

	function badgeColorClass(color?: BadgeColor): string {
		switch (color) {
			case "blue":   return "bg-blue-500/20 text-blue-300";
			case "green":  return "bg-green-500/20 text-green-300";
			case "red":    return "bg-red-500/20 text-red-300";
			case "yellow": return "bg-yellow-500/20 text-yellow-300";
			case "purple": return "bg-purple-500/20 text-purple-300";
			case "gray":
			default:       return "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]";
		}
	}

	// ── Status state to dot color + animation ──

	function statusDotClass(s: StatusState): string {
		switch (s) {
			case "running": return "bg-blue-400 animate-pulse";
			case "success": return "bg-green-500";
			case "error":   return "bg-red-500";
			case "warning": return "bg-yellow-500";
			case "idle":
			default:        return "bg-[var(--color-surface-tertiary)] border border-[var(--color-border)]";
		}
	}

	// ── List item status icons ──

	function listStatusIcon(s?: ListItemStatus): string {
		switch (s) {
			case "active":    return "\u25B6";
			case "completed": return "\u2713";
			case "failed":    return "\u2717";
			case "pending":
			default:          return "\u25CB";
		}
	}

	function listStatusColor(s?: ListItemStatus): string {
		switch (s) {
			case "active":    return "text-blue-400";
			case "completed": return "text-green-400";
			case "failed":    return "text-red-400";
			case "pending":
			default:          return "text-[var(--color-text-muted)]";
		}
	}

	// ── Text variant color ──

	function textVariantClass(v?: TextVariant): string {
		switch (v) {
			case "muted":    return "text-[var(--color-text-muted)]";
			case "emphasis": return "text-[var(--color-text-primary)] font-medium";
			case "default":
			default:         return "text-[var(--color-text-secondary)]";
		}
	}
</script>

{#if panelState}
<div class="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
	<!-- Collapsed header bar (always visible) -->
	<button
		type="button"
		onclick={() => (expanded = !expanded)}
		class="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--color-surface-secondary)]/50"
		aria-label={expanded ? "Collapse extension panel" : "Expand extension panel"}
	>
		<!-- Chevron -->
		<svg
			class="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform"
			class:rotate-180={expanded}
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2.5"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
		</svg>

		<!-- Extension name badge -->
		<span class="shrink-0 rounded bg-[var(--color-surface-tertiary)] px-1 py-0.5 text-[9px] font-medium text-[var(--color-text-muted)]">
			{extensionName}
		</span>

		<!-- Title -->
		<span class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
			{panelState.title}
		</span>

		<!-- Component count -->
		<span class="text-[10px] tabular-nums text-[var(--color-text-secondary)]">
			{componentCount} item{componentCount !== 1 ? "s" : ""}
		</span>
	</button>

	<!-- Expanded content -->
	{#if expanded}
		<div class="max-h-96 overflow-y-auto border-t border-[var(--color-border)] px-4 py-2 space-y-2" transition:slide={{ duration: 150 }}>
			{#each panelState.components as component}
				{#if component.type === "header"}
					<div>
						<div class="text-xs font-semibold text-[var(--color-text-primary)]">{component.title}</div>
						{#if component.subtitle}
							<div class="text-[10px] text-[var(--color-text-muted)]">{component.subtitle}</div>
						{/if}
					</div>

				{:else if component.type === "text"}
					<p class="text-xs leading-relaxed {textVariantClass(component.variant)}">{component.content}</p>

				{:else if component.type === "badge"}
					<span class="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium {badgeColorClass(component.color)}">
						{component.label}
					</span>

				{:else if component.type === "progress"}
					<div>
						{#if component.label}
							<div class="mb-0.5 flex items-center justify-between">
								<span class="text-[10px] text-[var(--color-text-muted)]">{component.label}</span>
								<span class="text-[10px] tabular-nums text-[var(--color-text-secondary)]">{Math.round(component.value)}%</span>
							</div>
						{/if}
						<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-tertiary)]">
							<div
								class="h-full rounded-full bg-blue-500 transition-all duration-300"
								style:width="{component.value}%"
							></div>
						</div>
					</div>

				{:else if component.type === "status"}
					<div class="flex items-center gap-2">
						<span class="h-2 w-2 shrink-0 rounded-full {statusDotClass(component.state)}"></span>
						<span class="text-xs text-[var(--color-text-secondary)]">{component.label}</span>
					</div>

				{:else if component.type === "list"}
					<div class="space-y-0.5">
						{#each component.items as item}
							<div class="flex items-start gap-2 py-0.5">
								{#if item.status != null}
									<span class="mt-0.5 shrink-0 text-[10px] leading-none {listStatusColor(item.status)}">
										{listStatusIcon(item.status)}
									</span>
								{/if}
								<div class="flex-1 min-w-0">
									<span class="text-xs text-[var(--color-text-secondary)]">{item.label}</span>
									{#if item.badge}
										<span class="ml-1 inline-block rounded-full px-1.5 py-0.5 text-[9px] font-medium {badgeColorClass(item.badgeColor)}">
											{item.badge}
										</span>
									{/if}
									{#if item.detail}
										<div class="text-[10px] text-[var(--color-text-muted)]">{item.detail}</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>

				{:else if component.type === "kv"}
					<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
						{#each component.pairs as pair}
							<span class="text-[10px] font-medium text-[var(--color-text-muted)]">{pair.key}</span>
							<span class="text-[10px] text-[var(--color-text-secondary)]">{pair.value}</span>
						{/each}
					</div>

				{:else if component.type === "counter"}
					<div>
						<div class="flex items-center justify-between">
							<span class="text-xs text-[var(--color-text-secondary)]">{component.label}</span>
							<span class="text-xs tabular-nums text-[var(--color-text-primary)]">
								{component.value}{#if component.total != null}/{component.total}{/if}
							</span>
						</div>
						{#if component.total != null && component.total > 0}
							<div class="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-tertiary)]">
								<div
									class="h-full rounded-full bg-blue-500 transition-all duration-300"
									style:width="{Math.min(100, (component.value / component.total) * 100)}%"
								></div>
							</div>
						{/if}
					</div>

				{:else if component.type === "divider"}
					<hr class="border-[var(--color-border)]" />
				{/if}
			{/each}
		</div>
	{/if}
</div>
{/if}
