<script lang="ts">
	import { tick } from "svelte";
	import {
		computePct,
		computeTone,
		fmtTokens,
		tooltipText,
		groupToolBreakdown,
		type ContextBreakdown,
		type ToolBreakdownEntry,
	} from "$lib/context-usage-logic";

	let {
		usedTokens,
		contextWindow,
		breakdown = null,
		toolBreakdown = [],
		oncallclick,
	}: {
		usedTokens: number | null;
		contextWindow: number | null;
		breakdown?: ContextBreakdown | null;
		toolBreakdown?: readonly ToolBreakdownEntry[];
		/**
		 * Optional callback fired when a leaf-level call row is clicked.
		 * Receives the call's stable id so the chat page can scroll the
		 * matching `#tool-call-${id}` anchor into view. When omitted, call
		 * rows render as plain `<div>`s (no click affordance).
		 */
		oncallclick?: (callId: string) => void;
	} = $props();

	function handleCallClick(callId: string | undefined) {
		if (!oncallclick || !callId) return;
		// Close the popover so the scroll lands on a clean viewport — leaving
		// it open would obscure the target the user just navigated to.
		open = false;
		popoverStyle = "";
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		oncallclick(callId);
	}

	const TOOL_ROW_LIMIT = 6;
	const FUNC_ROW_LIMIT = 6;
	const CALL_ROW_LIMIT = 8;

	// Roll per-function entries into per-tool groups. Top level is one row
	// per extension/MCP server (or per built-in tool); the function pills
	// only appear when a group is expanded.
	let toolGroups = $derived(groupToolBreakdown(toolBreakdown));
	let visibleGroups = $derived(toolGroups.slice(0, TOOL_ROW_LIMIT));
	let hiddenGroupCount = $derived(Math.max(0, toolGroups.length - TOOL_ROW_LIMIT));

	// Click-to-expand state. Two independent sets so opening a group
	// doesn't auto-open every function inside it. Keys are stable strings
	// so that a re-render with the same shape preserves what was open.
	let expandedGroups = $state<Set<string>>(new Set());
	let expandedFns = $state<Set<string>>(new Set());

	function fnKey(g: { key: string }, fn: { toolName: string }): string {
		return `${g.key}::${fn.toolName}`;
	}

	async function toggleGroup(g: { key: string }) {
		const next = new Set(expandedGroups);
		if (next.has(g.key)) next.delete(g.key);
		else next.add(g.key);
		expandedGroups = next;
		// Popover height changes — re-clamp so it doesn't fall off the viewport.
		await tick();
		positionPopover();
	}

	async function toggleFn(g: { key: string }, fn: { toolName: string }) {
		const k = fnKey(g, fn);
		const next = new Set(expandedFns);
		if (next.has(k)) next.delete(k);
		else next.add(k);
		expandedFns = next;
		await tick();
		positionPopover();
	}

	let pct = $derived(computePct(usedTokens, contextWindow));
	let tone = $derived(computeTone(pct));
	let summary = $derived(tooltipText(usedTokens, contextWindow));

	let triggerEl = $state<HTMLDivElement | null>(null);
	let popoverEl = $state<HTMLDivElement | null>(null);
	let open = $state(false);
	let popoverStyle = $state("");
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	const MARGIN = 8;
	const GAP = 6;
	// Brief grace period so the cursor can traverse the gap into the popover
	// without `mouseleave` snapping it shut.
	const HIDE_DELAY_MS = 120;

	async function handleEnter() {
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		open = true;
		await tick();
		positionPopover();
	}

	function handleLeave() {
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			open = false;
			popoverStyle = "";
			hideTimer = null;
		}, HIDE_DELAY_MS);
	}

	function positionPopover() {
		if (!triggerEl || !popoverEl) return;
		const trig = triggerEl.getBoundingClientRect();
		const pop = popoverEl.getBoundingClientRect();
		let top = trig.bottom + GAP;
		if (top + pop.height + MARGIN > window.innerHeight) {
			top = Math.max(MARGIN, trig.top - pop.height - GAP);
		}
		let left = trig.left + trig.width / 2 - pop.width / 2;
		left = Math.max(MARGIN, Math.min(left, window.innerWidth - pop.width - MARGIN));
		popoverStyle = `left:${Math.round(left)}px; top:${Math.round(top)}px;`;
	}
</script>

<svelte:window
	onresize={open ? positionPopover : undefined}
	onscroll={open ? positionPopover : undefined}
/>

{#if pct != null}
	<div
		bind:this={triggerEl}
		class="relative inline-flex"
		onmouseenter={handleEnter}
		onmouseleave={handleLeave}
		onfocusin={handleEnter}
		onfocusout={handleLeave}
		role="button"
		tabindex="0"
		aria-haspopup="dialog"
		aria-expanded={open}
	>
		<div
			data-testid="context-usage-indicator"
			data-tone={tone}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium tabular-nums cursor-help
				{tone === 'danger' ? 'text-[var(--color-error, #f87171)]' : ''}
				{tone === 'warn' ? 'text-[var(--color-warning, #facc15)]' : ''}
				{tone === 'muted' ? 'text-[var(--color-text-secondary)]' : ''}"
			aria-label="Context used: {Math.round(pct)} percent"
		>
			<div class="relative h-1.5 w-10 overflow-hidden rounded-full bg-[var(--color-surface-tertiary)]">
				<div
					data-testid="context-usage-bar"
					class="absolute inset-y-0 left-0 rounded-full transition-all
						{tone === 'danger' ? 'bg-[var(--color-error, #f87171)]' : ''}
						{tone === 'warn' ? 'bg-[var(--color-warning, #facc15)]' : ''}
						{tone === 'muted' ? 'bg-[var(--color-text-muted)]' : ''}"
					style="width: {pct}%"
				></div>
			</div>
			<span data-testid="context-usage-pct">{Math.round(pct)}%</span>
		</div>

		{#snippet callList(calls: readonly { callId?: string; tokens: number; pct: number; preview: string }[])}
			<div
				class="mt-0.5 space-y-0.5 border-l border-[var(--color-border)] pl-3 ml-2"
				data-testid="ctx-bd-call-list"
			>
				{#each calls.slice(0, CALL_ROW_LIMIT) as call, i (i)}
					{@const clickable = !!oncallclick && !!call.callId}
					{#if clickable}
						<button
							type="button"
							class="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
							data-testid="ctx-bd-call-row"
							data-call-id={call.callId}
							title="Jump to this tool call in the chat"
							onclick={() => handleCallClick(call.callId)}
						>
							<span class="min-w-0 truncate font-mono text-[var(--color-text-muted)]">
								{call.preview || "(no input)"}
							</span>
							<span class="shrink-0 tabular-nums">
								{fmtTokens(call.tokens)}
								<span class="ml-1 text-[var(--color-text-muted)]">({call.pct.toFixed(1)}%)</span>
							</span>
						</button>
					{:else}
						<div
							class="flex items-baseline justify-between gap-2 text-[10px] text-[var(--color-text-secondary)]"
							data-testid="ctx-bd-call-row"
						>
							<span class="min-w-0 truncate font-mono text-[var(--color-text-muted)]">
								{call.preview || "(no input)"}
							</span>
							<span class="shrink-0 tabular-nums">
								{fmtTokens(call.tokens)}
								<span class="ml-1 text-[var(--color-text-muted)]">({call.pct.toFixed(1)}%)</span>
							</span>
						</div>
					{/if}
				{/each}
				{#if calls.length > CALL_ROW_LIMIT}
					<div
						class="text-[10px] text-[var(--color-text-muted)]"
						data-testid="ctx-bd-call-overflow"
					>
						+{calls.length - CALL_ROW_LIMIT} more calls
					</div>
				{/if}
			</div>
		{/snippet}

		{#if open}
			<div
				bind:this={popoverEl}
				data-testid="context-usage-popover"
				role="dialog"
				class="fixed z-50 w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3 text-xs text-[var(--color-text-primary)] shadow-lg"
				style={popoverStyle}
			>
				<div class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
					Context Percentage
				</div>

				{#if breakdown}
					<div class="space-y-1.5 tabular-nums">
						<div class="flex items-baseline justify-between gap-2">
							<span class="text-[var(--color-text-secondary)]">Input</span>
							<span data-testid="ctx-bd-input">
								{fmtTokens(breakdown.inputTokens)}
								<span class="ml-1 text-[var(--color-text-muted)]">({breakdown.pctInput.toFixed(1)}%)</span>
							</span>
						</div>
						<div class="flex items-baseline justify-between gap-2">
							<span class="text-[var(--color-text-secondary)]">Output</span>
							<span data-testid="ctx-bd-output">
								{fmtTokens(breakdown.outputTokens)}
								<span class="ml-1 text-[var(--color-text-muted)]">({breakdown.pctOutput.toFixed(1)}%)</span>
							</span>
						</div>
						<div class="my-1 border-t border-[var(--color-border)]"></div>
						<div class="flex items-baseline justify-between gap-2 font-medium">
							<span>Total</span>
							<span data-testid="ctx-bd-total">{fmtTokens(breakdown.totalTokens)} tokens</span>
						</div>
						<div class="flex items-baseline justify-between gap-2">
							<span class="text-[var(--color-text-secondary)]">Tool calls</span>
							<span data-testid="ctx-bd-tools">
								{fmtTokens(breakdown.toolTokens)}
								<span class="ml-1 text-[var(--color-text-muted)]">({breakdown.pctTools.toFixed(1)}%)</span>
							</span>
						</div>

						{#if visibleGroups.length > 0}
							<div class="mt-1 space-y-1" data-testid="ctx-bd-tool-list">
								{#each visibleGroups as g (g.key)}
									{@const groupOpen = expandedGroups.has(g.key)}
									{@const visibleFns = g.functions.slice(0, FUNC_ROW_LIMIT)}
									{@const hiddenFnCount = Math.max(0, g.functions.length - FUNC_ROW_LIMIT)}
									{@const builtinCalls = g.isBuiltin ? (g.functions[0]?.calls ?? []) : []}
									<div
										data-testid="ctx-bd-tool-group"
										data-expanded={groupOpen}
										data-builtin={g.isBuiltin}
									>
										<button
											type="button"
											class="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-[10px] hover:bg-[var(--color-surface-tertiary)]"
											data-testid="ctx-bd-tool-row"
											data-tool={g.displayName}
											data-ext={g.extensionName}
											aria-expanded={groupOpen}
											onclick={() => toggleGroup(g)}
										>
											<span class="flex min-w-0 flex-wrap items-center gap-1">
												<span
													class="inline-block w-3 shrink-0 text-center text-[var(--color-text-muted)] transition-transform"
													style={groupOpen ? "transform: rotate(90deg)" : ""}
													aria-hidden="true"
												>›</span>
												<span
													data-testid="ctx-bd-tool-pill"
													class="rounded px-1.5 py-px font-medium {g.isBuiltin
														? 'bg-emerald-500/20 text-emerald-300'
														: 'bg-indigo-500/20 text-indigo-300'}"
												>
													{g.displayName}
												</span>
												{#if !g.isBuiltin}
													<span
														class="text-[var(--color-text-muted)]"
														data-testid="ctx-bd-tool-fn-count"
													>
														{g.functions.length} fn{g.functions.length === 1 ? "" : "s"}
													</span>
												{/if}
												{#if g.callCount > 1}
													<span class="text-[var(--color-text-muted)]">×{g.callCount}</span>
												{/if}
											</span>
											<span class="shrink-0 tabular-nums text-[var(--color-text-secondary)]">
												{fmtTokens(g.tokens)}
												<span class="ml-1 text-[var(--color-text-muted)]">({g.pct.toFixed(1)}%)</span>
											</span>
										</button>

										{#if groupOpen}
											{#if g.isBuiltin}
												<!-- Built-ins skip the function level — there's only one
													function per group, so jump straight to the call list. -->
												{@render callList(builtinCalls)}
											{:else}
												<!-- Extension/MCP groups: list functions, each itself
													expandable to its per-call breakdown. -->
												<div
													class="mt-0.5 space-y-0.5 border-l border-[var(--color-border)] pl-3 ml-2"
													data-testid="ctx-bd-fn-list"
												>
													{#each visibleFns as fn (fn.toolName)}
														{@const fnOpen = expandedFns.has(fnKey(g, fn))}
														<div data-testid="ctx-bd-fn-group" data-expanded={fnOpen}>
															<button
																type="button"
																class="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-[10px] hover:bg-[var(--color-surface-tertiary)]"
																data-testid="ctx-bd-fn-row"
																data-fn={fn.toolName}
																aria-expanded={fnOpen}
																onclick={() => toggleFn(g, fn)}
															>
																<span class="flex min-w-0 flex-wrap items-center gap-1">
																	<span
																		class="inline-block w-3 shrink-0 text-center text-[var(--color-text-muted)] transition-transform"
																		style={fnOpen ? "transform: rotate(90deg)" : ""}
																		aria-hidden="true"
																	>›</span>
																	<span
																		data-testid="ctx-bd-fn-pill"
																		class="rounded bg-emerald-500/20 px-1.5 py-px font-medium text-emerald-300"
																	>
																		{fn.toolName}
																	</span>
																	{#if fn.callCount > 1}
																		<span class="text-[var(--color-text-muted)]">×{fn.callCount}</span>
																	{/if}
																</span>
																<span class="shrink-0 tabular-nums text-[var(--color-text-secondary)]">
																	{fmtTokens(fn.tokens)}
																	<span class="ml-1 text-[var(--color-text-muted)]">({fn.pct.toFixed(1)}%)</span>
																</span>
															</button>

															{#if fnOpen}
																{@render callList(fn.calls)}
															{/if}
														</div>
													{/each}
													{#if hiddenFnCount > 0}
														<div
															class="text-[10px] text-[var(--color-text-muted)]"
															data-testid="ctx-bd-fn-overflow"
														>
															+{hiddenFnCount} more fns
														</div>
													{/if}
												</div>
											{/if}
										{/if}
									</div>
								{/each}
								{#if hiddenGroupCount > 0}
									<div class="text-[10px] text-[var(--color-text-muted)]" data-testid="ctx-bd-tool-overflow">
										+{hiddenGroupCount} more
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{:else}
					<div class="text-[var(--color-text-secondary)]">{summary}</div>
				{/if}

				<div class="mt-2 border-t border-[var(--color-border)] pt-2 text-[var(--color-text-muted)]">
					{summary}
				</div>
			</div>
		{/if}
	</div>
{/if}
