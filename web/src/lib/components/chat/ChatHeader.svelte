<script lang="ts">
	import MentionText from "$lib/components/MentionText.svelte";
	import Tooltip from "$lib/components/Tooltip.svelte";
	import ContextUsageIndicator from "$lib/components/ContextUsageIndicator.svelte";
	import PermissionModeIndicator from "$lib/components/PermissionModeIndicator.svelte";
	import ExportMenu from "$lib/components/ExportMenu.svelte";
	import type { Conversation } from "$lib/api.js";
	import type { PermissionMode } from "$lib/permission-mode.js";
	import type { ContextBreakdown, ToolBreakdownEntry } from "$lib/context-usage-logic";

	type LoadedTool = {
		name: string;
		description: string;
		extension: string;
		extensionType?: string;
		tokenEstimate?: number;
	};

	interface Props {
		projectId: string;
		convId: string;
		currentConversation: Conversation | null;
		lastTurnInputTokens: number | null;
		selectedModelContextWindow: number | null;
		contextBreakdown: ContextBreakdown | null;
		contextToolBreakdown: readonly ToolBreakdownEntry[];
		loadedTools: LoadedTool[];
		toolsByExtension: Map<string, LoadedTool[]>;
		extensionTypeMap: Map<string, string>;
		toolsOpen: boolean;
		diffPanelOpen: boolean;
		diffFileCount: number;
		activeLeafId: string | null;
		showObsButton: boolean;
		obsOpen: boolean;
		selectMode: boolean;
		isStreaming: boolean;
		onmobilemenu: () => void;
		ontoolstoggle: (next: boolean) => void;
		ondifftoggle: () => void;
		onobstoggle: () => void;
		onselecttoggle: () => void;
		onsettingstoggle: () => void;
		onpermissionmodechange: (mode: PermissionMode | undefined) => void;
		oncallclick: (callId: string) => void;
		onrename: (title: string) => void | Promise<void>;
	}

	let {
		projectId,
		convId,
		currentConversation,
		lastTurnInputTokens,
		selectedModelContextWindow,
		contextBreakdown,
		contextToolBreakdown,
		loadedTools,
		toolsByExtension,
		extensionTypeMap,
		toolsOpen,
		diffPanelOpen,
		diffFileCount,
		activeLeafId,
		showObsButton,
		obsOpen,
		selectMode,
		isStreaming,
		onmobilemenu,
		ontoolstoggle,
		ondifftoggle,
		onobstoggle,
		onselecttoggle,
		onsettingstoggle,
		onpermissionmodechange,
		oncallclick,
		onrename,
	}: Props = $props();

	let editing = $state(false);
	let editValue = $state("");
	let saving = $state(false);

	function startEditing() {
		if (!currentConversation) return;
		editValue = currentConversation.title ?? "";
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		saving = false;
	}

	async function saveEdit() {
		if (!editing || saving) return;
		const trimmed = editValue.trim();
		const original = currentConversation?.title ?? "";
		if (!trimmed || trimmed === original) {
			cancelEdit();
			return;
		}
		saving = true;
		try {
			await onrename(trimmed);
			editing = false;
		} finally {
			saving = false;
		}
	}
</script>

<!-- Chat Header -->
<div class="flex flex-col md:flex-row md:items-center md:justify-between border-b border-[var(--color-border)] px-2 md:px-4 py-2 gap-1">
	<div class="flex items-center gap-1 min-w-0 md:flex-1">
	<!-- Mobile menu button -->
	<button
		onclick={() => onmobilemenu()}
		class="md:hidden flex items-center justify-center rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
		aria-label="Open conversations"
		style="min-width: 44px; min-height: 44px;"
	>
		<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
		</svg>
	</button>
	{#if editing}
		<form
			class="flex-1 min-w-0 flex items-center gap-2"
			onsubmit={(e) => { e.preventDefault(); saveEdit(); }}
		>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				data-testid="chat-title-input"
				type="text"
				bind:value={editValue}
				autofocus
				disabled={saving}
				onkeydown={(e) => { if (e.key === "Escape") cancelEdit(); }}
				class="flex-1 min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
			<button
				data-testid="chat-title-save"
				type="submit"
				disabled={saving}
				class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
			>Save</button>
			<button
				data-testid="chat-title-cancel"
				type="button"
				onclick={cancelEdit}
				disabled={saving}
				class="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
			>Cancel</button>
		</form>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span
			data-testid="chat-title"
			title="Double-click to rename"
			ondblclick={startEditing}
			class="truncate text-sm font-medium text-[var(--color-text-secondary)] flex-1 min-w-0 cursor-text select-none"
		>
			<MentionText text={currentConversation?.title ?? "Chat"} />
		</span>
	{/if}
	</div>
	<div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
		<!-- Context usage -->
		<ContextUsageIndicator
			usedTokens={lastTurnInputTokens}
			contextWindow={selectedModelContextWindow}
			breakdown={contextBreakdown}
			toolBreakdown={contextToolBreakdown}
			oncallclick={oncallclick}
		/>
		<!-- Permission mode indicator -->
		<Tooltip position="bottom" text="How tool-use permission is granted for this project (ask / auto / deny)">
			<PermissionModeIndicator {projectId} conversationId={convId} onmodechange={(mode) => { onpermissionmodechange(mode); }} />
		</Tooltip>
		<!-- Tool count indicator -->
		<Tooltip position="bottom" text="Tools loaded in this chat ({loadedTools.length}) — click to inspect names and token cost">
		<div class="relative">
			<button
				onclick={() => ontoolstoggle(!toolsOpen)}
				class="flex items-center rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors {toolsOpen ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
				aria-label="Loaded tools ({loadedTools.length})"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21.75 6.75a4.5 4.5 0 01-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 11-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 016.336-4.486l-3.276 3.276a3.004 3.004 0 002.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852z" />
				</svg>
				<span class="text-[10px] ml-0.5">{loadedTools.length}</span>
			</button>
			{#if toolsOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div data-testid="tools-backdrop" class="fixed inset-0 z-40" onclick={() => ontoolstoggle(false)} onkeydown={() => {}}></div>
				<div data-testid="tools-popover" class="absolute right-0 top-full z-50 mt-1 w-[calc(100vw-2rem)] md:w-64 max-w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg max-h-72 overflow-y-auto">
					{#if loadedTools.length === 0}
						<p class="px-3 py-2 text-xs text-[var(--color-text-muted)]">No tools loaded</p>
					{:else}
						{#each [...toolsByExtension] as [ext, tools]}
							{@const extType = extensionTypeMap.get(ext) ?? "extension"}
							{@const groupTokens = tools.reduce((sum, t) => sum + (t.tokenEstimate ?? 0), 0)}
							<div class="px-3 py-2">
							<p class="text-xs font-bold text-[var(--color-text-secondary)] flex items-center gap-1.5">{ext}
									<span data-testid="type-badge" class="uppercase text-[9px] font-semibold px-1 py-0.5 rounded {extType === 'agent' ? 'bg-purple-900/50 text-purple-300' : extType === 'mcp' ? 'bg-blue-900/50 text-blue-300' : 'bg-green-900/50 text-green-300'}">{extType}</span>
									<span class="text-[var(--color-text-muted)] text-[9px] ml-auto inline-flex items-center gap-0.5">{groupTokens}<svg class="inline h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">T</text></svg></span>
								</p>
								{#each tools as tool}
									<p class="text-xs text-[var(--color-text-secondary)] pl-2 py-0.5" title={tool.description}>{tool.name}{#if tool.tokenEstimate}<span class="text-[var(--color-text-muted)] ml-1 inline-flex items-center gap-0.5">~{tool.tokenEstimate}<svg class="inline h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">T</text></svg></span>{/if}</p>
								{/each}
							</div>
						{/each}
						<div class="border-t border-[var(--color-border)] px-3 py-2 flex items-center justify-between">
							<span class="text-xs font-bold text-[var(--color-text-secondary)]">Total</span>
							<span class="text-[var(--color-text-secondary)] text-[9px] inline-flex items-center gap-0.5">{loadedTools.reduce((sum, t) => sum + (t.tokenEstimate ?? 0), 0)}<svg class="inline h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">T</text></svg></span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
		</Tooltip>
		<Tooltip position="bottom" text="Review files changed by tool calls in this conversation">
		<button
				data-testid="diff-panel-btn"
				onclick={() => ondifftoggle()}
				class="relative rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors {diffPanelOpen ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
				aria-label="Diff summary"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5.586a1 1 0 01.293-.707l5.414-5.414A1 1 0 0115.414 0H17a2 2 0 012 2v17a2 2 0 01-2 2z" />
				</svg>
				{#if diffFileCount > 0}
					<span data-testid="diff-badge" class="absolute -bottom-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold leading-none text-white">{diffFileCount}</span>
				{/if}
			</button>
		</Tooltip>
		<Tooltip position="bottom" text="Export this conversation as Markdown or JSON">
			<ExportMenu conversationId={convId} leafMessageId={activeLeafId ?? undefined} />
		</Tooltip>
		{#if showObsButton}
			<Tooltip position="bottom" text="Inspect tool-call traces and LLM request logs">
			<button
				onclick={() => onobstoggle()}
				class="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors {obsOpen ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
				aria-label="Inspect observability"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
				</svg>
			</button>
			</Tooltip>
		{/if}
		<Tooltip position="bottom" text={isStreaming ? "Finish streaming turn before selecting" : selectMode ? "Exit select mode" : "Select turns to fork into a new chat"}>
		<button
			onclick={() => onselecttoggle()}
			disabled={isStreaming}
			class="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed {selectMode ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
			aria-label={selectMode ? "Exit select mode" : "Select turns to fork into a new chat"}
			data-testid="select-mode-toggle"
			aria-pressed={selectMode}
		>
			<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
			</svg>
		</button>
		</Tooltip>
		<Tooltip position="bottom" text="Configure this conversation (model, system prompt, extensions)">
		<button
			onclick={() => onsettingstoggle()}
			class="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
			aria-label="Conversation settings"
		>
			<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
					d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
			</svg>
		</button>
		</Tooltip>
	</div>
</div>
