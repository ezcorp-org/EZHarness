<script lang="ts">
	/**
	 * Per-conversation tool scoping popover for the chat composer (Phase 4/D).
	 *
	 * Mirrors ModeSelector's popover pattern (bottom-full absolute, click-
	 * outside, search). With a mode that attaches extensions, it lists those
	 * as the inherited baseline and lets the user narrow which tools are
	 * active for THIS conversation (the executor enforces narrow-only within
	 * the mode allowlist). WITHOUT a mode allowlist it lists every installed
	 * extension that exposes tools — the same surface the header's loaded-
	 * tools badge shows — and the toggles narrow via the executor's no-mode
	 * deny path (computeModeToolScope), so unchecking a tool here is just as
	 * real as it is under a mode. Disabled extensions are excluded from
	 * both listings because their tools are never registered — a toggle
	 * for them would be a meaningless no-op.
	 *
	 * State model (shared with the rest of the app via `$lib/tool-scope-logic`):
	 *   - `value` is the conversation's extensionTools map (or null = inherit).
	 *   - A key absent / empty = all of that extension's (mode-allowed) tools.
	 *   - `onchange(map)` persists a narrowed map; `onreset()` clears the
	 *     override back to the default (null).
	 */
	import { onMount } from "svelte";
	import Tooltip from "$lib/components/Tooltip.svelte";
	import type { Mode } from "$lib/api";
	import {
		isAllTools,
		isExtensionOff,
		isToolChecked,
		toggleExtension as logicToggleExtension,
		toggleTool as logicToggleTool,
		type ToolScopeMap,
	} from "$lib/tool-scope-logic";

	let {
		selectedMode = null,
		value = null,
		orchestrationTools = [],
		conversationId = "",
		onchange,
		onreset,
	}: {
		selectedMode?: Mode | null;
		value?: ToolScopeMap | null;
		/** Scopes the caller-tools fetch. Empty (no conversation yet) skips it —
		 *  declarations are per-conversation, so there is nothing to ask for. */
		conversationId?: string;
		/** Namespaced (`<ext>__<tool>`) names of the always-wired
		 *  orchestration tools — their extensions (ask-user, scratchpad)
		 *  are listed even when the active mode doesn't attach them, since
		 *  they ride through the mode allowlist and only an explicit
		 *  conversation toggle removes them. */
		orchestrationTools?: string[];
		onchange: (map: ToolScopeMap) => void;
		onreset: () => void;
	} = $props();

	interface ToolInfo { name: string; description?: string | null }
	interface ExtInfo { id: string; name: string; description?: string | null; enabled?: boolean; tools: ToolInfo[] }

	/** The pseudo-extension id caller tools are toggled under. A literal, not a
	 *  UUID — a real extension NAMED `caller` cannot collide, because
	 *  `extData` and the persisted map are both keyed by extension UUID. */
	const CALLER_EXT_ID = "caller";

	let open = $state(false);
	let extData = $state<Record<string, ExtInfo>>({});
	let callerSection = $state<ExtInfo | null>(null);
	let loaded = $state(false);

	async function loadExtensions(): Promise<void> {
		const res = await fetch("/api/extensions");
		if (!res.ok) return;
		const data = await res.json();
		const list: unknown[] = Array.isArray(data)
			? data
			: Array.isArray(data?.extensions) ? data.extensions : [];
		const map: Record<string, ExtInfo> = {};
		for (const e of list as Array<{ id: string; name?: string; description?: string | null; enabled?: boolean; manifest?: { tools?: ToolInfo[] } }>) {
			map[e.id] = {
				id: e.id,
				name: e.name ?? e.id,
				description: e.description,
				enabled: e.enabled,
				tools: Array.isArray(e.manifest?.tools) ? e.manifest!.tools! : [],
			};
		}
		extData = map;
	}

	/**
	 * Caller-executed tools are NOT in `/api/extensions` — they live in the
	 * conversation's own metadata, declared over HTTP by whatever client
	 * device is connected. They are synthesised into one section so the
	 * existing toggle path treats them like any other extension: the
	 * persisted map is `Record<extId, string[]>` with plain `map[extId]`
	 * access, so `"caller"` needs no special case anywhere downstream.
	 */
	async function loadCallerTools(): Promise<void> {
		if (!conversationId) return;
		const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/caller-tools`);
		if (!res.ok) return;
		const data = await res.json();
		const tools: ToolInfo[] = Array.isArray(data?.tools)
			? (data.tools as Array<{ name: string; description?: string | null }>).map((t) => ({
					name: t.name,
					description: t.description,
				}))
			: [];
		if (tools.length === 0) return;
		callerSection = {
			id: CALLER_EXT_ID,
			name: "Caller tools",
			description: "Tools executed on your connected client device",
			tools,
		};
	}

	onMount(async () => {
		// Both in flight together: they are independent reads and the popover
		// is gated on ONE `loaded` flag, so serialising them would just make
		// the first paint later. `allSettled` (not `all`) because either read
		// failing is non-fatal and must not hide the other's success — the
		// popover renders whatever resolved.
		await Promise.allSettled([loadExtensions(), loadCallerTools()]);
		loaded = true;
	});

	// The inherited baseline: the mode's attached extensions, each restricted
	// to the mode's own extensionTools subset (so the conversation can only
	// narrow within what the mode already allows).
	const modeExtIds = $derived(selectedMode?.extensionIds ?? []);
	const modeScope = $derived<ToolScopeMap>(selectedMode?.extensionTools ?? {});

	// Resolved sections. With a mode allowlist: the attached extensions in
	// attachment order, each carrying the tool list the mode actually grants
	// (intersection of manifest tools and the mode's subset) — PLUS the
	// orchestration extensions (ask-user, scratchpad, …), which stay wired
	// regardless of the mode and are only removable by an explicit toggle
	// here. Without a mode: every installed extension that exposes tools
	// (name-sorted) — the same surface the header badge lists. Disabled
	// extensions (`enabled === false`) are excluded from every path: their
	// tools are never registered, so a toggle would be a no-op.
	const hasMode = $derived(modeExtIds.length > 0);
	const orchestrationSet = $derived(new Set(orchestrationTools));
	const isOrchestrationExt = (ext: ExtInfo) =>
		ext.tools.some((t) => orchestrationSet.has(`${ext.name}__${t.name}`));
	// `undefined` (older API shapes / fixtures) counts as enabled.
	const isEnabledExt = (ext: ExtInfo) => ext.enabled !== false;
	// The caller section, when the conversation declared any. Appended LAST in
	// both branches: a mode cannot name a caller tool (modes reference
	// extension ids), so it belongs to neither the inherited baseline nor the
	// installed-extension listing — it is the connected device's own surface.
	const callerSections = $derived(callerSection ? [callerSection] : []);
	let sections = $derived(
		hasMode
			? [
					...modeExtIds
						.map((id) => extData[id])
						.filter((e): e is ExtInfo => Boolean(e))
						.filter(isEnabledExt)
						.map((ext) => {
							// Absent = all; [] = off (mirrors computeModeToolScope).
							const modeSubset = modeScope[ext.id];
							const grantedTools = !modeSubset
								? ext.tools
								: ext.tools.filter((t) => modeSubset.includes(t.name));
							return { ...ext, tools: grantedTools };
						}),
					...Object.values(extData)
						.filter((ext) => isEnabledExt(ext) && !modeExtIds.includes(ext.id) && isOrchestrationExt(ext))
						.sort((a, b) => a.name.localeCompare(b.name)),
					...callerSections,
				]
			: [
					...Object.values(extData)
						.filter((ext) => isEnabledExt(ext) && ext.tools.length > 0)
						.sort((a, b) => a.name.localeCompare(b.name)),
					...callerSections,
				],
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

	// Master on/off for a whole extension. OFF persists `[]` (a state the
	// per-tool collapse rule never produces), which the runtime + /api/tools
	// listing read as "no tools from this extension".
	function toggleExt(ext: ExtInfo) {
		onchange(logicToggleExtension(convMap, ext.id));
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
		title="Scope which tools are active for this conversation"
	>
		<span aria-hidden="true">🔧</span>
		<span>Tools</span>
		{#if sections.length > 0}
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
					<span
						class="text-[10px] {isCustomized ? 'text-amber-400' : 'text-[var(--color-text-muted)]'}"
						data-testid="conversation-tools-state"
					>
						{isCustomized
							? "Customized"
							: hasMode
								? `Inherited from ${selectedMode?.name ?? "mode"}`
								: "All extensions"}
					</span>
				</div>
				<div class="text-[10px] text-[var(--color-text-muted)]">
					{hasMode
						? "Narrow which of this mode's tools are active here. Unchecking removes a tool for this conversation only."
						: "Narrow which extension tools are active here. Unchecking removes a tool for this conversation only."}
				</div>
			</div>

			{#if !loaded}
				<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">Loading tools…</div>
			{:else if sections.length === 0}
				<div class="px-3 py-3 text-xs text-[var(--color-text-muted)]" data-testid="conversation-tools-empty">
					{hasMode
						? "This mode's extensions expose no tools."
						: "No installed extensions expose tools."}
				</div>
			{:else}
				{#each sections as ext (ext.id)}
					{@const extOff = isExtensionOff(convMap, ext.id)}
					<div class="px-3 py-1.5">
						<div class="flex">
						<Tooltip
							position="right"
							header={ext.name}
							text={ext.description || (extOff ? `Enable ${ext.name} for this conversation` : `Disable all of ${ext.name}'s tools for this conversation`)}
						>
						<label
							class="mb-1 flex w-full cursor-pointer items-center gap-2 text-[11px] font-medium {extOff ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-primary)]'}"
						>
							<input
								type="checkbox"
								checked={!extOff}
								onchange={() => toggleExt(ext)}
								data-testid={`conv-ext-toggle-${ext.id}`}
							/>
							<span>{ext.name}</span>
							{#if extOff}
								<span class="text-[9px] uppercase text-[var(--color-text-muted)]">off</span>
							{/if}
						</label>
						</Tooltip>
						</div>
						{#if ext.tools.length === 0}
							<p class="text-[10px] italic text-[var(--color-text-muted)]">No tools.</p>
						{:else}
							<div class="flex flex-col gap-1 pl-5 {extOff ? 'opacity-50' : ''}">
								{#each ext.tools as tool (tool.name)}
									{@const checked = isToolChecked(convMap, ext.id, tool.name)}
									<div class="flex">
									<Tooltip position="right" header={tool.name} text={tool.description || "No description provided."}>
									<label class="flex w-full cursor-pointer items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
										<input
											type="checkbox"
											{checked}
											onchange={() => toggle(ext, tool.name)}
											data-testid={`conv-tool-${ext.id}-${tool.name}`}
										/>
										<span class="font-mono text-[var(--color-text-primary)]">{tool.name}</span>
									</label>
									</Tooltip>
									</div>
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
						{hasMode ? "Reset to mode default" : "Reset to all tools"}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
