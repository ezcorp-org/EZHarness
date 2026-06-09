<script lang="ts">
	/**
	 * Per-conversation tool scoping popover for the chat composer (Phase 4/D).
	 *
	 * Mirrors ModeSelector's popover pattern (bottom-full absolute, click-
	 * outside, search). Lists the active mode's attached extensions as the
	 * inherited baseline and lets the user narrow which tools are active for
	 * THIS conversation. The narrowing can only subtract from the mode's
	 * allowlist (the executor enforces narrow-only) — so the inherited baseline
	 * here is the mode's own extensionTools, and the conversation override
	 * further restricts it.
	 *
	 * State model (shared with the rest of the app via `$lib/tool-scope-logic`):
	 *   - `value` is the conversation's extensionTools map (or null = inherit).
	 *   - A key absent / empty = all of that extension's (mode-allowed) tools.
	 *   - `onchange(map)` persists a narrowed map; `onreset()` clears the
	 *     override back to the mode default (null).
	 */
	import { onMount } from "svelte";
	import type { Mode } from "$lib/api";
	import {
		isAllTools,
		isToolChecked,
		toggleTool as logicToggleTool,
		type ToolScopeMap,
	} from "$lib/tool-scope-logic";

	let {
		selectedMode = null,
		value = null,
		onchange,
		onreset,
	}: {
		selectedMode?: Mode | null;
		value?: ToolScopeMap | null;
		onchange: (map: ToolScopeMap) => void;
		onreset: () => void;
	} = $props();

	interface ToolInfo { name: string; description?: string | null }
	interface ExtInfo { id: string; name: string; tools: ToolInfo[] }

	let open = $state(false);
	let extData = $state<Record<string, ExtInfo>>({});
	let loaded = $state(false);

	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (res.ok) {
				const data = await res.json();
				const list: unknown[] = Array.isArray(data)
					? data
					: Array.isArray(data?.extensions) ? data.extensions : [];
				const map: Record<string, ExtInfo> = {};
				for (const e of list as Array<{ id: string; name?: string; manifest?: { tools?: ToolInfo[] } }>) {
					map[e.id] = {
						id: e.id,
						name: e.name ?? e.id,
						tools: Array.isArray(e.manifest?.tools) ? e.manifest!.tools! : [],
					};
				}
				extData = map;
			}
		} catch { /* non-fatal */ }
		finally { loaded = true; }
	});

	// The inherited baseline: the mode's attached extensions, each restricted
	// to the mode's own extensionTools subset (so the conversation can only
	// narrow within what the mode already allows).
	const modeExtIds = $derived(selectedMode?.extensionIds ?? []);
	const modeScope = $derived<ToolScopeMap>(selectedMode?.extensionTools ?? {});

	// Resolved sections (attached + known) in attachment order, each carrying
	// the tool list the mode actually grants (intersection of manifest tools
	// and the mode's subset).
	let sections = $derived(
		modeExtIds
			.map((id) => extData[id])
			.filter((e): e is ExtInfo => Boolean(e))
			.map((ext) => {
				const modeSubset = modeScope[ext.id];
				const grantedTools =
					!modeSubset || modeSubset.length === 0
						? ext.tools
						: ext.tools.filter((t) => modeSubset.includes(t.name));
				return { ...ext, tools: grantedTools };
			}),
	);

	// The conversation override map we mutate. Null means "inherit" — we treat
	// it as an empty map for rendering (all checked) and only emit a non-empty
	// map on narrowing.
	const convMap = $derived<ToolScopeMap>(value ?? {});
	const isCustomized = $derived(value !== null && Object.keys(value ?? {}).length > 0);

	// Total active tool count under the current selection (for the badge).
	let activeCount = $derived(
		sections.reduce((sum, ext) => {
			if (isAllTools(convMap, ext.id)) return sum + ext.tools.length;
			return sum + ext.tools.filter((t) => isToolChecked(convMap, ext.id, t.name)).length;
		}, 0),
	);

	const hasMode = $derived(modeExtIds.length > 0);

	function toggleOpen() {
		open = !open;
	}
	function close() {
		open = false;
	}

	function toggle(ext: ExtInfo, toolName: string) {
		const all = ext.tools.map((t) => t.name);
		const next = logicToggleTool(convMap, ext.id, toolName, all);
		onchange(next);
	}

	function handleReset() {
		onreset();
	}

	function handleClickOutside(e: MouseEvent) {
		if (!(e.target as HTMLElement).closest(".conv-tools-selector")) close();
	}
</script>

<svelte:window onclick={handleClickOutside} />

<div data-testid="conversation-tools-selector" class="conv-tools-selector relative">
	<button
		onclick={toggleOpen}
		data-testid="conversation-tools-trigger"
		class="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
		title="Scope which of this mode's tools are active for this conversation"
	>
		<span aria-hidden="true">🔧</span>
		<span>Tools</span>
		{#if hasMode}
			<span
				class="rounded-full bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
				data-testid="conversation-tools-count"
			>
				{activeCount}
			</span>
		{/if}
		<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if open}
		<div class="absolute bottom-full left-0 mb-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-1 shadow-xl z-50" data-testid="conversation-tools-popover">
			<div class="px-3 py-1.5 border-b border-[var(--color-border)] mb-1">
				<div class="flex items-center justify-between">
					<div class="text-xs font-medium text-[var(--color-text-primary)]">Conversation tools</div>
					{#if hasMode}
						<span
							class="text-[10px] {isCustomized ? 'text-amber-400' : 'text-[var(--color-text-muted)]'}"
							data-testid="conversation-tools-state"
						>
							{isCustomized ? "Customized" : `Inherited from ${selectedMode?.name ?? "mode"}`}
						</span>
					{/if}
				</div>
				{#if hasMode}
					<div class="text-[10px] text-[var(--color-text-muted)]">
						Narrow which of this mode's tools are active here. Unchecking
						removes a tool for this conversation only.
					</div>
				{/if}
			</div>

			{#if !hasMode}
				<div class="px-3 py-3 text-xs text-[var(--color-text-muted)]" data-testid="conversation-tools-empty">
					No mode with attached extensions is active. Pick a mode to scope
					its tools per conversation.
				</div>
			{:else if !loaded}
				<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">Loading tools…</div>
			{:else if sections.length === 0}
				<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">This mode's extensions expose no tools.</div>
			{:else}
				{#each sections as ext (ext.id)}
					<div class="px-3 py-1.5">
						<div class="mb-1 text-[11px] font-medium text-[var(--color-text-primary)]">{ext.name}</div>
						{#if ext.tools.length === 0}
							<p class="text-[10px] italic text-[var(--color-text-muted)]">No tools.</p>
						{:else}
							<div class="flex flex-col gap-1">
								{#each ext.tools as tool (tool.name)}
									{@const checked = isToolChecked(convMap, ext.id, tool.name)}
									<label class="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
										<input
											type="checkbox"
											{checked}
											onchange={() => toggle(ext, tool.name)}
											data-testid={`conv-tool-${ext.id}-${tool.name}`}
										/>
										<span class="font-mono text-[var(--color-text-primary)]">{tool.name}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
				{/each}

				<div class="mt-1 border-t border-[var(--color-border)] pt-1">
					<button
						onclick={handleReset}
						disabled={!isCustomized}
						data-testid="conversation-tools-reset"
						class="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:hover:text-[var(--color-text-muted)]"
					>
						Reset to mode default
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
