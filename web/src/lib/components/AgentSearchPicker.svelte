<script lang="ts">
	import { onMount } from "svelte";
	import { inputClass } from "$lib/styles.js";
	import type { AgentConfig } from "$lib/api";
	import BottomSheet from "$lib/components/BottomSheet.svelte";
	import { useBreakpoint } from "$lib/use-breakpoint.svelte";

	let {
		agents,
		placeholder = "Search agents...",
		onselect,
	}: {
		agents: AgentConfig[];
		placeholder?: string;
		onselect: (agent: AgentConfig) => void;
	} = $props();

	// Phase 57 UX-01 Wave 2: wrap picker body in BottomSheet on <lg.
	const bp = useBreakpoint("lg");

	let inputEl: HTMLInputElement | undefined = $state();
	let query = $state("");
	let open = $state(false);
	let highlightIdx = $state(-1);
	let dropdownStyle = $state("");

	// Phase 57 UX-03 Wave 3: saved-search + pinned-agent prefs.
	// Source-of-truth is /api/user/agent-picker (settings KV); silent
	// degrade to empty arrays if unreachable so the picker stays usable.
	interface SavedSearch {
		query: string;
		createdAt: number;
	}
	let savedSearches: SavedSearch[] = $state([]);
	let pinned: string[] = $state([]);

	async function loadPrefs(): Promise<void> {
		try {
			const res = await fetch("/api/user/agent-picker");
			if (!res.ok) return;
			const data = await res.json();
			savedSearches = Array.isArray(data?.savedSearches) ? data.savedSearches : [];
			pinned = Array.isArray(data?.pinned) ? data.pinned : [];
		} catch {
			// Silent — picker remains usable without prefs.
		}
	}

	async function persistPrefs(updates: Partial<{ savedSearches: SavedSearch[]; pinned: string[] }>): Promise<void> {
		try {
			await fetch("/api/user/agent-picker", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(updates),
			});
		} catch {
			// Silent — non-blocking UX.
		}
	}

	onMount(loadPrefs);

	function saveCurrentSearch(): void {
		const q = query.trim();
		if (!q) return;
		if (savedSearches.some((s) => s.query === q)) return;
		savedSearches = [...savedSearches, { query: q, createdAt: Date.now() }];
		void persistPrefs({ savedSearches });
	}

	function unsaveSearch(q: string): void {
		savedSearches = savedSearches.filter((s) => s.query !== q);
		void persistPrefs({ savedSearches });
	}

	function applySavedSearch(q: string): void {
		query = q;
		if (inputEl) inputEl.value = q;
		highlightIdx = -1;
	}

	function pinAgent(agentId: string): void {
		if (pinned.includes(agentId)) return;
		pinned = [...pinned, agentId];
		void persistPrefs({ pinned });
	}

	function unpinAgent(agentId: string): void {
		pinned = pinned.filter((id) => id !== agentId);
		void persistPrefs({ pinned });
	}

	let filtered = $derived(() => {
		if (!query.trim()) return agents;
		const lq = query.toLowerCase();
		return agents.filter(
			(a) => a.name.toLowerCase().includes(lq) || a.description.toLowerCase().includes(lq),
		);
	});

	// Derived list of pinned agents that still resolve in the current agents
	// prop (client-side guard — server already orphan-trims on GET, but the
	// agents prop reflects the page's current snapshot).
	let pinnedAgents = $derived(() => {
		const byId = new Map(agents.map((a) => [a.id, a]));
		return pinned
			.map((id) => byId.get(id))
			.filter((a): a is AgentConfig => a !== undefined);
	});

	function computePosition() {
		if (!inputEl) return;
		const rect = inputEl.getBoundingClientRect();
		dropdownStyle = `position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;width:${Math.max(rect.width, 320)}px;z-index:9999;`;
	}

	function openDropdown() {
		open = true;
		highlightIdx = -1;
		computePosition();
	}

	function closeDropdown() {
		open = false;
		highlightIdx = -1;
		query = "";
	}

	function selectAgent(agent: AgentConfig) {
		onselect(agent);
		closeDropdown();
		inputEl?.blur();
	}

	function onInput() {
		query = inputEl?.value ?? "";
		highlightIdx = -1;
		if (!open) openDropdown();
		else computePosition();
	}

	function onFocus() {
		if (!open) openDropdown();
	}

	function onBlur() {
		setTimeout(closeDropdown, 150);
	}

	function onKeydown(e: KeyboardEvent) {
		const items = filtered();
		if (!open || items.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlightIdx = Math.max(highlightIdx - 1, 0);
		} else if (e.key === "Enter" && highlightIdx >= 0) {
			e.preventDefault();
			selectAgent(items[highlightIdx]!);
		} else if (e.key === "Escape") {
			closeDropdown();
		}
	}

	function onClickOutside(e: MouseEvent) {
		if (!open) return;
		if (inputEl?.contains(e.target as Node)) return;
		// Don't close if click landed inside the picker body (saved/pinned
		// affordances live there). Tag the body wrapper with a known data
		// attribute and walk up from the event target.
		const target = e.target as Node | null;
		if (target instanceof Element) {
			if (target.closest("[data-agent-picker-body]")) return;
		}
		closeDropdown();
	}
</script>

<svelte:document onclick={onClickOutside} />

<div class="relative">
	<div class="relative">
		<svg class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
		</svg>
		<input
			type="text"
			bind:this={inputEl}
			value={query}
			oninput={onInput}
			onfocus={onFocus}
			onblur={onBlur}
			onkeydown={onKeydown}
			{placeholder}
			role="combobox"
			aria-expanded={open}
			aria-controls="agent-picker-listbox"
			aria-haspopup="listbox"
			aria-autocomplete="list"
			aria-activedescendant={highlightIdx >= 0 ? `agent-picker-item-${highlightIdx}` : undefined}
			autocomplete="off"
			data-testid="open-agent-picker"
			class="{inputClass} w-full pl-8 text-sm"
		/>
	</div>
</div>

{#snippet pickerBody()}
	{@const items = filtered()}
	{@const pinnedList = pinnedAgents()}
	<div data-agent-picker-body class="flex flex-col gap-1">
		<!-- Save-search affordance row -->
		<div class="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1">
			<span class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
				{query.trim() ? `Save "${query.trim()}"?` : "Saved searches"}
			</span>
			<button
				type="button"
				data-testid="save-search-button"
				onmousedown={(e) => { e.preventDefault(); saveCurrentSearch(); }}
				disabled={!query.trim() || savedSearches.some((s) => s.query === query.trim())}
				aria-label="Save current search"
				class="rounded px-2 py-0.5 text-xs text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-surface-tertiary)] disabled:opacity-40"
			>Save search</button>
		</div>

		{#if savedSearches.length > 0}
			<div data-testid="saved-searches" class="border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-1">
				{#each savedSearches as s (s.query)}
					<div class="flex items-center justify-between px-2 py-1 hover:bg-[var(--color-surface-tertiary)]">
						<button
							type="button"
							onmousedown={(e) => { e.preventDefault(); applySavedSearch(s.query); }}
							class="flex-1 truncate text-left text-xs text-[var(--color-text-primary)]"
						>{s.query}</button>
						<button
							type="button"
							onmousedown={(e) => { e.preventDefault(); unsaveSearch(s.query); }}
							aria-label={`Remove saved search ${s.query}`}
							class="px-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
						>×</button>
					</div>
				{/each}
			</div>
		{/if}

		{#if pinnedList.length > 0}
			<div data-testid="pinned-agents" class="border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-1">
				<span class="px-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Pinned</span>
				{#each pinnedList as agent (agent.id)}
					<div class="flex items-center justify-between px-2 py-1 hover:bg-[var(--color-surface-tertiary)]">
						<button
							type="button"
							onmousedown={() => selectAgent(agent)}
							class="flex-1 truncate text-left text-sm text-[var(--color-text-primary)]"
						>{agent.name}</button>
						<button
							type="button"
							onmousedown={(e) => { e.preventDefault(); unpinAgent(agent.id); }}
							aria-label={`Unpin ${agent.name}`}
							data-testid={`unpin-${agent.id}`}
							class="px-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
						>Unpin</button>
					</div>
				{/each}
			</div>
		{/if}

		<ul
			id="agent-picker-listbox"
			class="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
			role="listbox"
			aria-label="Available agents"
		>
			{#if items.length === 0}
				<li role="option" aria-selected="false" class="px-3 py-3 text-center text-xs text-[var(--color-text-muted)]">
					{query ? "No matching agents" : "No agents available"}
				</li>
			{:else}
				{#each items as agent, i (agent.id)}
					<li
						id="agent-picker-item-{i}"
						role="option"
						aria-selected={i === highlightIdx}
						data-testid="agent-row"
						class="flex items-stretch"
					>
						<button
							type="button"
							tabindex="-1"
							class="flex flex-1 flex-col gap-0.5 px-3 py-2 text-left transition-colors {i === highlightIdx
								? 'bg-[var(--color-surface-tertiary)]'
								: 'bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
							onmousedown={() => selectAgent(agent)}
							onmouseenter={() => (highlightIdx = i)}
						>
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">{agent.name}</span>
								{#if agent.category}
									<span class="rounded-full bg-[var(--color-surface-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{agent.category}</span>
								{/if}
							</div>
							{#if agent.description}
								<span class="truncate text-xs text-[var(--color-text-muted)]">{agent.description}</span>
							{/if}
							{#if i === highlightIdx && agent.prompt}
								<div class="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-primary)] p-2 text-xs text-[var(--color-text-secondary)]">
									<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">System Prompt</div>
									<p class="line-clamp-3">{agent.prompt}</p>
									{#if agent.provider || agent.model}
										<div class="mt-1 flex gap-2 text-[10px] text-[var(--color-text-muted)]">
											{#if agent.provider}<span>Provider: {agent.provider}</span>{/if}
											{#if agent.model}<span>Model: {agent.model}</span>{/if}
										</div>
									{/if}
								</div>
							{/if}
						</button>
						<button
							type="button"
							tabindex="-1"
							onmousedown={(e) => { e.stopPropagation(); e.preventDefault(); if (pinned.includes(agent.id)) { unpinAgent(agent.id); } else { pinAgent(agent.id); } }}
							aria-label={pinned.includes(agent.id) ? `Unpin ${agent.name}` : `Pin agent`}
							data-testid={`pin-${agent.id}`}
							class="shrink-0 px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] {i === highlightIdx ? 'bg-[var(--color-surface-tertiary)]' : 'bg-[var(--color-surface-secondary)]'}"
						>{pinned.includes(agent.id) ? "Pinned" : "Pin"}</button>
					</li>
				{/each}
			{/if}
		</ul>
	</div>
{/snippet}

{#if open && bp.below}
	<BottomSheet open={true} onclose={closeDropdown} ariaLabel="Agent picker">
		{@render pickerBody()}
	</BottomSheet>
{:else if open}
	<div style={dropdownStyle}>
		{@render pickerBody()}
	</div>
{/if}
