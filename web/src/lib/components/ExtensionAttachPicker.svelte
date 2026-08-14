<script lang="ts">
	/**
	 * ExtensionAttachPicker — Phase 49.4.
	 *
	 * Visual modal picker for attaching extensions to an agent. Reuses
	 * the `/extensions` Installed-grid card styling so users get
	 * familiar visual signposts (name, description, tool count).
	 *
	 * Why a separate component vs. the existing `ExtensionSearchPicker`:
	 * the inline combobox works for power users who know what they
	 * want, but new users need a browseable visual grid — that's the
	 * EATT-01/02 requirement carried over from v1.2. This picker is
	 * triggered from `AgentConfigForm.svelte` as an "Attach extension"
	 * button alongside the existing search-picker (which stays for
	 * keyboard-driven workflows).
	 *
	 * Selection model: multi-select. Submit returns the chosen ids
	 * back through `onsubmit(ids)`. Initial selection is supplied via
	 * `initialSelected` so re-opening the picker on an edit form
	 * reflects the agent's currently-attached extensions.
	 */
	import { onMount } from "svelte";
	import { fuzzyScore } from "$lib/fuzzy-match.js";
	import BottomSheet from "$lib/components/BottomSheet.svelte";
	import { useBreakpoint } from "$lib/use-breakpoint.svelte";
	import {
		isAllTools,
		isToolChecked,
		toggleTool as logicToggleTool,
		pruneDetached,
		type ToolScopeMap,
	} from "$lib/tool-scope-logic";

	interface ExtensionItem {
		id: string;
		name: string;
		description?: string | null;
		/** The row's `source` column — carried so `itemFilter` can see it. */
		source?: string | null;
		manifest?: { tools?: Array<{ name: string }> };
	}

	let {
		open,
		initialSelected = [],
		initialExtensionTools = {},
		itemFilter,
		onclose,
		onsubmit,
	}: {
		open: boolean;
		initialSelected?: string[];
		initialExtensionTools?: ToolScopeMap;
		/**
		 * Optional predicate narrowing which installed rows are offerable
		 * at all. Applied to the fetched list, so the empty state and the
		 * selection count both reflect it. Used by the extension-author
		 * composition panel to keep the VIRTUAL `builtin` row (native
		 * tools — not a real extension) out of the dependency picker.
		 */
		itemFilter?: (ext: { id: string; source?: string | null }) => boolean;
		onclose: () => void;
		onsubmit: (ids: string[], extensionTools: ToolScopeMap) => void;
	} = $props();

	// Phase 57 UX-01 Wave 2: wrap picker body in BottomSheet on <lg.
	const bp = useBreakpoint("lg");

	let extensions = $state<ExtensionItem[]>([]);
	let loadError = $state("");
	let query = $state("");
	// Initialize empty; `$effect` below seeds from `initialSelected`
	// the first time the modal opens (and re-syncs every subsequent
	// open). Initializing here from the prop would only capture the
	// caller's *initial* array, not later updates — Svelte 5 flags
	// that pattern (state_referenced_locally).
	let selected = $state<Set<string>>(new Set());
	// Per-card tool scoping map (extension id → tool-name subset). Mirrors the
	// `extension_tools` model; driven by the shared `tool-scope-logic` rules.
	// Absent / empty subset for an attached extension = all tools.
	let scopeMap = $state<ToolScopeMap>({});
	// Which cards have their inline tool checklist expanded.
	let expanded = $state<Set<string>>(new Set());
	let loaded = $state(false);

	// Re-sync `selected` + `scopeMap` whenever the modal opens with fresh
	// `initialSelected`. Without this, opening, deselecting, closing
	// without submit, then re-opening would persist the deselection.
	$effect(() => {
		if (open) {
			selected = new Set(initialSelected);
			scopeMap = { ...initialExtensionTools };
			expanded = new Set();
		}
	});

	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (!res.ok) {
				loadError = `Failed to load extensions (${res.status})`;
				return;
			}
			const data = await res.json();
			const list: unknown[] = Array.isArray(data)
				? data
				: Array.isArray(data?.extensions)
					? data.extensions
					: [];
			extensions = list
				.map((e) => {
					const ext = e as Record<string, unknown>;
					return {
						id: String(ext.id ?? ""),
						name: String(ext.name ?? ext.id ?? ""),
						description:
							(ext.description as string | undefined) ?? null,
						source: (ext.source as string | undefined) ?? null,
						manifest: ext.manifest as ExtensionItem["manifest"],
					};
				})
				.filter((ext) => (itemFilter ? itemFilter(ext) : true));
		} catch {
			loadError = "Failed to load extensions";
		} finally {
			loaded = true;
		}
	});

	let filtered = $derived(() => {
		const q = query.trim();
		if (!q) return extensions;
		// Reuse the same fuzzy matcher the rest of the app uses for
		// consistency (see CommandPalette, /agents search, mention search).
		return extensions
			.map((e) => ({
				ext: e,
				score:
					Math.max(
						fuzzyScore(q, e.name) ?? -Infinity,
						fuzzyScore(q, e.description ?? "") ?? -Infinity,
					),
			}))
			.filter((row) => row.score > -Infinity)
			.sort((a, b) => b.score - a.score)
			.map((row) => row.ext);
	});

	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function toggleExpanded(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function toolNames(ext: ExtensionItem): string[] {
		return (ext.manifest?.tools ?? []).map((t) => t.name);
	}

	function toggleScopeTool(ext: ExtensionItem, toolName: string) {
		scopeMap = logicToggleTool(scopeMap, ext.id, toolName, toolNames(ext));
	}

	function handleSubmit() {
		const ids = [...selected];
		// Drop scoping for any extension that ended up unselected.
		onsubmit(ids, pruneDetached(scopeMap, ids));
		onclose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === "Escape") {
			e.preventDefault();
			onclose();
		}
	}

	function toolCount(ext: ExtensionItem): number {
		return ext.manifest?.tools?.length ?? 0;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet pickerBody()}
	<!-- Header -->
	<div class="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
		<div>
			<h2 class="text-lg font-semibold text-[var(--color-text-primary)]">
				Attach extensions
			</h2>
			<p class="text-xs text-[var(--color-text-muted)]">
				Select the extensions whose tools this agent should use.
			</p>
		</div>
		<button
			type="button"
			onclick={onclose}
			aria-label="Close picker"
			class="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
			style="min-width: 44px; min-height: 44px;"
		>
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
			</svg>
		</button>
	</div>

	<!-- Search -->
	<div class="border-b border-[var(--color-border)] px-5 py-3">
		<div class="relative">
			<svg
				class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
				/>
			</svg>
			<input
				type="search"
				bind:value={query}
				placeholder="Search extensions by name or description..."
				aria-label="Search extensions"
				data-testid="extension-attach-picker-search"
				class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-2 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
		</div>
	</div>

	<!-- Body: extension grid -->
	<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
		{#if !loaded}
			<p class="text-sm text-[var(--color-text-muted)]">Loading extensions...</p>
		{:else if loadError}
			<p class="text-sm text-red-400">{loadError}</p>
		{:else if filtered().length === 0}
			<p
				class="text-sm text-[var(--color-text-muted)]"
				data-testid="extension-attach-picker-empty"
			>
				{#if query.trim()}
					No extensions match "{query}".
				{:else}
					No extensions installed yet.
				{/if}
			</p>
		{:else}
			<div class="grid gap-3 sm:grid-cols-2">
				{#each filtered() as ext (ext.id)}
					{@const isSelected = selected.has(ext.id)}
					{@const isExpanded = expanded.has(ext.id)}
					<!-- `min-w-0` on the GRID ITEM and on the flex-column child it
					     stretches. A grid item defaults to `min-width: auto`, so a
					     64-char extension name (the server's own ceiling) set the
					     track's min-content width: measured at a 393px viewport the
					     card rendered 822px and this scroll pane scrolled sideways to
					     842px, with the name barely clipped (712 of 722px). -->
					<div
						data-testid="extension-attach-picker-card"
						data-ext-id={ext.id}
						data-selected={isSelected ? "true" : "false"}
						class="flex min-w-0 flex-col rounded-lg border transition-colors {isSelected
							? 'border-blue-500 bg-blue-900/20'
							: 'border-[var(--color-border)] bg-[var(--color-surface-secondary)]'}"
					>
						<button
							type="button"
							onclick={() => toggle(ext.id)}
							aria-pressed={isSelected}
							class="flex w-full min-w-0 flex-col items-start rounded-t-lg p-3 text-left transition-colors {isSelected
								? ''
								: 'hover:bg-[var(--color-surface-tertiary)]'}"
							style="min-height: 88px;"
						>
							<div class="flex w-full min-w-0 items-center gap-2">
								<span
									class="flex h-4 w-4 shrink-0 items-center justify-center rounded border {isSelected
										? 'border-blue-500 bg-blue-600 text-white'
										: 'border-[var(--color-border)] text-transparent'}"
								>
									{#if isSelected}
										<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
										</svg>
									{/if}
								</span>
								<span class="truncate text-sm font-medium text-[var(--color-text-primary)]">
									{ext.name}
								</span>
								<span
									class="ml-auto shrink-0 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
									title="Tool count"
								>
									{toolCount(ext)} tools
								</span>
							</div>
							{#if ext.description}
								<!-- `w-full`: this button is `items-start`, so the paragraph is
								     NOT stretched — it sized to its own max-content (1290px for
								     a description holding a pasted URL) and `line-clamp-2` then
								     clipped nothing, because the box was as wide as the text. -->
								<p class="mt-2 line-clamp-2 w-full break-words text-xs text-[var(--color-text-muted)]">
									{ext.description}
								</p>
							{/if}
						</button>

						<!-- Inline per-card tool scoping — only meaningful once the
						     extension is selected and exposes tools. Driven by the
						     shared tool-scope-logic rules. -->
						{#if isSelected && toolCount(ext) > 0}
							<div class="border-t border-[var(--color-border)] px-3 py-2">
								<button
									type="button"
									onclick={() => toggleExpanded(ext.id)}
									data-testid={`attach-card-tools-toggle-${ext.id}`}
									aria-expanded={isExpanded}
									class="flex w-full items-center justify-between text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
								>
									<span class="flex items-center gap-1">
										<span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span> Tools
									</span>
									<span class="text-[var(--color-text-muted)]">
										{isAllTools(scopeMap, ext.id)
											? "All tools"
											: `${scopeMap[ext.id].length} selected`}
									</span>
								</button>
								{#if isExpanded}
									<div class="mt-2 flex flex-col gap-1">
										{#each ext.manifest?.tools ?? [] as tool (tool.name)}
											{@const checked = isToolChecked(scopeMap, ext.id, tool.name)}
											<label class="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-secondary)]">
												<input
													type="checkbox"
													{checked}
													onchange={() => toggleScopeTool(ext, tool.name)}
													data-testid={`attach-card-tool-${ext.id}-${tool.name}`}
												/>
												<span class="font-mono text-[var(--color-text-primary)]">{tool.name}</span>
											</label>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Footer -->
	<div class="flex items-center justify-between border-t border-[var(--color-border)] px-5 py-3">
		<span class="text-xs text-[var(--color-text-muted)]" data-testid="extension-attach-picker-count">
			{selected.size} selected
		</span>
		<div class="flex gap-2">
			<button
				type="button"
				onclick={onclose}
				class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
				style="min-height: 36px;"
			>
				Cancel
			</button>
			<button
				type="button"
				onclick={handleSubmit}
				data-testid="extension-attach-picker-submit"
				class="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
				style="min-height: 36px;"
			>
				Attach ({selected.size})
			</button>
		</div>
	</div>
{/snippet}

{#if open && bp.below}
	<BottomSheet open={true} onclose={onclose} ariaLabel="Attach extension picker">
		<!-- Preserve the picker's external dialog identity so existing
		     tests can still find `extension-attach-picker` / `-panel`. -->
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Attach extensions"
			data-testid="extension-attach-picker"
			class="flex flex-col"
		>
			<div
				class="flex flex-col"
				data-testid="extension-attach-picker-panel"
			>
				{@render pickerBody()}
			</div>
		</div>
	</BottomSheet>
{:else if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Attach extensions"
		tabindex="-1"
		data-testid="extension-attach-picker"
		onclick={(e) => {
			// Click on backdrop (not panel) closes.
			if (e.target === e.currentTarget) onclose();
		}}
	>
		<div
			class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
			data-testid="extension-attach-picker-panel"
		>
			{@render pickerBody()}
		</div>
	</div>
{/if}
