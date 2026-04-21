<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import type { AgentConfig } from "$lib/api";

	let {
		agents,
		placeholder = "Search agents...",
		onselect,
	}: {
		agents: AgentConfig[];
		placeholder?: string;
		onselect: (agent: AgentConfig) => void;
	} = $props();

	let inputEl: HTMLInputElement | undefined = $state();
	let query = $state("");
	let open = $state(false);
	let highlightIdx = $state(-1);
	let dropdownStyle = $state("");

	let filtered = $derived(() => {
		if (!query.trim()) return agents;
		const lq = query.toLowerCase();
		return agents.filter(
			(a) => a.name.toLowerCase().includes(lq) || a.description.toLowerCase().includes(lq),
		);
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
			class="{inputClass} w-full pl-8 text-sm"
		/>
	</div>
</div>

{#if open}
	{@const items = filtered()}
	<div style={dropdownStyle}>
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
					>
						<button
							type="button"
							tabindex="-1"
							class="flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors {i === highlightIdx
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
					</li>
				{/each}
			{/if}
		</ul>
	</div>
{/if}
