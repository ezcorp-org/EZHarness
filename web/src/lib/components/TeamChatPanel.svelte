<script lang="ts">
	import { tick } from "svelte";
	import { store, closeTeamPanel, openTeamDrillDown, closeTeamDrillDown, getTaskSnapshot } from "$lib/stores.svelte.js";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import { agentColor } from "$lib/agent-color.js";
	import { timeAgo, timeDelta } from "$lib/format-duration.js";
	import { toolStatusIcon, toolStatusColor, formatInput } from "$lib/tool-display.js";
	import PanelChatInput from "./PanelChatInput.svelte";
	import { backgroundFetch, userFetch } from "$lib/utils/fetch-policy.js";
	import { readExpandedTools, writeExpandedTools, readScroll, writeScroll } from "$lib/panel-persistence.js";

	// ── Types ──

	interface ToolCallInfo {
		id: string;
		toolName: string;
		input: Record<string, unknown> | null;
		outputSummary: string | null;
		success: boolean;
		durationMs: number;
		status: string;
	}

	interface TeamMessage {
		id: string;
		role: string;
		content: string;
		createdAt: string;
		toolCalls: ToolCallInfo[];
	}

	interface TeamMember {
		agentConfigId: string;
		agentName: string;
	}

	interface TeamStream {
		agentConfigId: string;
		agentName: string;
		subConversationId: string;
		messages: TeamMessage[];
	}

	interface TimelineEntry {
		message: TeamMessage;
		agentName: string;
		color: string;
		subConversationId: string;
		timestamp: number;
		agentTurnIndex: number;
	}

	interface TeamOverviewData {
		team: { name: string; members: TeamMember[] };
		orchestrator?: TeamStream;
		streams: TeamStream[];
	}

	// ── Derived panel state ──

	let panelOpen = $derived(store.teamPanel.open);
	let agentConfigId = $derived(store.teamPanel.agentConfigId);
	let teamName = $derived(store.teamPanel.teamName);
	let conversationId = $derived(store.teamPanel.conversationId);
	let drillDown = $derived(store.teamPanel.drillDownAgent);

	// Check if the team assignment is currently running
	let teamProcessing = $derived.by(() => {
		if (!conversationId || !agentConfigId) return false;
		const snapshot = getTaskSnapshot(conversationId);
		if (!snapshot) return false;
		for (const task of snapshot.tasks) {
			for (const a of task.assignments) {
				if (a.agentConfigId === agentConfigId && a.status === "running") return true;
			}
		}
		return false;
	});

	// ── View A: Team overview state ──

	let overviewData = $state<TeamOverviewData | null>(null);
	let overviewLoading = $state(false);
	let overviewLoaded = $state(false);

	// ── View B: Drill-down state ──

	let drillMessages = $state<TeamMessage[]>([]);
	let drillLoading = $state(false);
	let drillLoaded = $state(false);

	// ── Tool call expansion ──
	// Initialized empty; restored from storage when conversationId is known
	// (see the `prevConfigId` effect below).

	let expandedTools = $state(new Set<string>());
	function toggleTool(id: string) {
		const next = new Set(expandedTools);
		if (next.has(id)) next.delete(id); else next.add(id);
		expandedTools = next;
		if (conversationId) writeExpandedTools(conversationId, [...next]);
	}

	// ── Data loading ──

	async function loadOverview() {
		if (overviewLoaded || overviewLoading || !conversationId || !agentConfigId) return;
		overviewLoading = true;
		try {
			// One-shot load on panel open; the auto-refresh poll lower down
			// uses backgroundFetch so it does NOT collide with this call.
			const res = await userFetch(`/api/conversations/${conversationId}/team/${agentConfigId}/messages`);
			if (res.ok) {
				overviewData = await res.json();
			}
		} catch { /* silent */ }
		overviewLoaded = true; // Mark loaded even on error to prevent retry loop
		overviewLoading = false;
	}

	async function loadDrillDown() {
		if (drillLoaded || drillLoading || !drillDown?.subConversationId) return;
		drillLoading = true;
		try {
			// User-initiated drill-in (click on a team member). One-shot.
			const res = await userFetch(`/api/conversations/${drillDown.subConversationId}/messages?withToolCalls=true`);
			if (res.ok) {
				const data = await res.json();
				drillMessages = data.messages ?? data;
			}
		} catch { /* silent */ }
		drillLoaded = true; // Mark loaded even on error to prevent retry loop
		drillLoading = false;
	}

	// Reset overview when agentConfigId changes; restore expanded-tools
	// state from localStorage so the user's prior expansion survives a
	// page refresh.
	let prevConfigId = $state<string | null>(null);
	$effect(() => {
		if (agentConfigId !== prevConfigId) {
			prevConfigId = agentConfigId;
			overviewData = null;
			overviewLoaded = false;
			expandedTools = new Set(conversationId ? readExpandedTools(conversationId) : []);
		}
		if (panelOpen && !drillDown && !overviewLoaded) loadOverview();
	});

	// Auto-refresh overview every 5s while panel is open (members become active as orchestrator invokes them).
	// Routed through the chat-area fetch policy: panel open + tab reactivate +
	// WS reconnect can collide on the same endpoint — dedup collapses them.
	$effect(() => {
		if (!panelOpen || drillDown) return;
		const interval = setInterval(async () => {
			if (!conversationId || !agentConfigId) return;
			try {
				const res = await backgroundFetch(
					`team:${conversationId}:${agentConfigId}`,
					`/api/conversations/${conversationId}/team/${agentConfigId}/messages`,
					{},
					{ minIntervalMs: 4500 },
				);
				if (res && res.ok) overviewData = await res.json();
			} catch { /* silent */ }
		}, 5000);
		return () => clearInterval(interval);
	});

	// Reset drill-down when drillDown agent changes; restore expanded-tools
	// from storage so a refresh keeps the user's prior expansion.
	let prevDrillSubConv = $state<string | null>(null);
	$effect(() => {
		const subConvId = drillDown?.subConversationId ?? null;
		if (subConvId !== prevDrillSubConv) {
			prevDrillSubConv = subConvId;
			drillMessages = [];
			drillLoaded = false;
			expandedTools = new Set(conversationId ? readExpandedTools(conversationId) : []);
		}
		if (panelOpen && drillDown && !drillLoaded) loadDrillDown();
	});

	// Immediate refresh when ANY sub-agent completes (private chat or
	// orchestrator-driven). The 5s polling above is the safety net; this
	// listener is what makes the user-perceived latency feel instant —
	// without it, sending a message in drill-down view, getting a response,
	// then switching back to the overview shows stale data for up to 5s
	// because the overview polling is paused while drill-down is active.
	$effect(() => {
		if (!panelOpen || typeof window === "undefined") return;
		const handleAgentComplete = async () => {
			if (!conversationId || !agentConfigId) return;
			// Refetch overview unconditionally — cheap and matches what the
			// 5s poll does. The fetch-policy throttle dedupes overlapping calls.
			try {
				const res = await userFetch(`/api/conversations/${conversationId}/team/${agentConfigId}/messages`);
				if (res.ok) overviewData = await res.json();
			} catch { /* silent */ }
			// If we're in drill-down, refetch that too.
			if (drillDown?.subConversationId) {
				try {
					const res = await userFetch(`/api/conversations/${drillDown.subConversationId}/messages?withToolCalls=true`);
					if (res.ok) {
						const data = await res.json();
						drillMessages = data.messages ?? data;
					}
				} catch { /* silent */ }
			}
		};
		window.addEventListener("ez:agent_complete", handleAgentComplete);
		return () => window.removeEventListener("ez:agent_complete", handleAgentComplete);
	});

	// Auto-refresh drill-down every 5s while panel is open on a drill-down view
	$effect(() => {
		if (!panelOpen || !drillDown?.subConversationId) return;
		const subConvId = drillDown.subConversationId;
		const interval = setInterval(async () => {
			try {
				const res = await backgroundFetch(
					`drill:${subConvId}`,
					`/api/conversations/${subConvId}/messages?withToolCalls=true`,
					{},
					{ minIntervalMs: 4500 },
				);
				if (res && res.ok) {
					const data = await res.json();
					drillMessages = data.messages ?? data;
				}
			} catch { /* silent */ }
		}, 5000);
		return () => clearInterval(interval);
	});

	// ── Drill-down derived data ──

	let drillAssistantMessages = $derived(drillMessages.filter(m => m.role === 'assistant'));
	let drillTaskMessage = $derived(drillMessages.find(m => m.role === 'user'));
	let drillTotalToolCalls = $derived(drillAssistantMessages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0));
	let drillScrollContainer: HTMLDivElement | undefined = $state();

	// Scroll to the specific turn (or bottom) when drill-down first loads.
	// Preference order: saved scroll offset (from prior session) → target
	// turn index from drill-down state → scroll to bottom.
	let drillInitialScroll = $state(false);
	$effect(() => {
		if (!panelOpen || !drillDown || !drillLoaded || drillAssistantMessages.length === 0 || !drillScrollContainer) return;
		if (drillInitialScroll) return;
		drillInitialScroll = true;
		const targetTurn = drillDown?.turnIndex;
		const savedDrill = conversationId ? readScroll(`team:${conversationId}`)?.drill : undefined;
		tick().then(() => {
			requestAnimationFrame(() => {
				if (!drillScrollContainer) return;
				if (savedDrill && savedDrill > 0) {
					drillScrollContainer.scrollTop = savedDrill;
					return;
				}
				if (targetTurn != null && targetTurn < drillAssistantMessages.length) {
					const el = drillScrollContainer.querySelector(`[data-drill-turn="${targetTurn}"]`);
					if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
				}
				// Fallback: scroll to bottom
				drillSentinel?.scrollIntoView({ behavior: 'instant' });
			});
		});
	});

	// Reset initial scroll flag when drill-down changes
	$effect(() => {
		if (drillDown) drillInitialScroll = false;
	});

	// ── Chronological timeline ──

	let timelineEntries = $derived.by(() => {
		if (!overviewData) return [];
		const entries: TimelineEntry[] = [];

		function addStream(stream: TeamStream) {
			if (!stream.subConversationId) return;
			let turnIdx = 0;
			let isFirstUserMsg = true;
			for (const msg of stream.messages) {
				if (msg.role === 'user') {
					// Skip the first user message in each stream (the initial task prompt)
					if (isFirstUserMsg) { isFirstUserMsg = false; continue; }
					entries.push({
						message: msg,
						agentName: '__user__',
						color: 'var(--color-accent)',
						subConversationId: stream.subConversationId,
						timestamp: new Date(msg.createdAt).getTime() || 0,
						agentTurnIndex: -1,
					});
					continue;
				}
				if (msg.role !== 'assistant') continue;
				entries.push({
					message: msg,
					agentName: stream.agentName,
					color: agentColor(stream.agentName),
					subConversationId: stream.subConversationId,
					timestamp: new Date(msg.createdAt).getTime() || 0,
					agentTurnIndex: turnIdx++,
				});
			}
		}

		if (overviewData.orchestrator) addStream(overviewData.orchestrator);
		for (const stream of overviewData.streams) addStream(stream);

		entries.sort((a, b) => a.timestamp - b.timestamp);
		return entries;
	});

	// Save/restore scroll position when toggling between overview and drill-down.
	// Saved when the user clicks an agent name; restored when timelineEl re-mounts.
	let savedTimelineScroll = $state(0);

	function drillDownWithScrollSave(subConversationId: string, agentName: string, turnIndex: number) {
		if (timelineEl) savedTimelineScroll = timelineEl.scrollTop;
		openTeamDrillDown(subConversationId, agentName, turnIndex);
	}

	// ── Scroll tracking ──

	let timelineEl: HTMLDivElement | undefined;
	let timelineSentinel: HTMLDivElement | undefined = $state();

	let drillSentinel: HTMLDivElement | undefined = $state();

	// Track whether user has scrolled up (for both views)
	let timelineUserScrolledUp = $state(false);
	let drillUserScrolledUp = $state(false);

	// IntersectionObserver for timeline sentinel
	$effect(() => {
		if (!timelineSentinel || !timelineEl) return;
		const obs = new IntersectionObserver(
			([entry]) => { timelineUserScrolledUp = !entry!.isIntersecting; },
			{ root: timelineEl, threshold: 0.1 },
		);
		obs.observe(timelineSentinel);
		return () => obs.disconnect();
	});

	// IntersectionObserver for drill-down sentinel
	$effect(() => {
		if (!drillSentinel || !drillScrollContainer) return;
		const obs = new IntersectionObserver(
			([entry]) => { drillUserScrolledUp = !entry!.isIntersecting; },
			{ root: drillScrollContainer, threshold: 0.1 },
		);
		obs.observe(drillSentinel);
		return () => obs.disconnect();
	});

	// Persist scroll position (debounced) so a refresh restores the
	// user's exact scroll offset. Keyed by conversationId.
	let scrollPersistTimer: ReturnType<typeof setTimeout> | undefined;
	function persistScrollDebounced() {
		if (!conversationId) return;
		const cid = conversationId;
		clearTimeout(scrollPersistTimer);
		scrollPersistTimer = setTimeout(() => {
			const existing = readScroll(`team:${cid}`) ?? {};
			writeScroll(`team:${cid}`, {
				timeline: timelineEl?.scrollTop ?? existing.timeline,
				drill: drillScrollContainer?.scrollTop ?? existing.drill,
			});
		}, 200);
	}

	$effect(() => {
		if (!timelineEl) return;
		const el = timelineEl;
		const onScroll = () => persistScrollDebounced();
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	$effect(() => {
		if (!drillScrollContainer) return;
		const el = drillScrollContainer;
		const onScroll = () => persistScrollDebounced();
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	// On first overview load, restore the user's saved scroll position
	// (from a prior session) if any; otherwise fall back to scroll-to-bottom.
	let timelineInitialScroll = $state(false);
	$effect(() => {
		if (!panelOpen || drillDown || !overviewLoaded || timelineEntries.length === 0) return;
		if (timelineInitialScroll) return;
		timelineInitialScroll = true;
		const saved = conversationId ? readScroll(`team:${conversationId}`)?.timeline : undefined;
		if (saved && saved > 0 && timelineEl) {
			tick().then(() => {
				requestAnimationFrame(() => {
					if (timelineEl) timelineEl.scrollTop = saved;
				});
			});
		} else {
			scrollTimelineToBottom();
		}
	});

	// Reset initial scroll flag when overview reloads (agent config change)
	$effect(() => {
		if (!overviewLoaded) timelineInitialScroll = false;
	});

	// Auto-scroll timeline when new entries arrive (from polling)
	let prevTimelineCount = $state(0);
	$effect(() => {
		const count = timelineEntries.length;
		if (count > prevTimelineCount && prevTimelineCount > 0 && !timelineUserScrolledUp) {
			scrollTimelineToBottom('smooth');
		}
		prevTimelineCount = count;
	});

	// Auto-scroll drill-down when new messages arrive (from polling)
	let prevDrillCount = $state(0);
	$effect(() => {
		const count = drillMessages.length;
		if (count > prevDrillCount && prevDrillCount > 0 && !drillUserScrolledUp) {
			scrollDrillToBottom('smooth');
		}
		prevDrillCount = count;
	});

	// Restore saved scroll position when returning from drill-down
	$effect(() => {
		if (timelineEntries.length > 0 && timelineEl && !drillDown && savedTimelineScroll > 0) {
			timelineEl.scrollTop = savedTimelineScroll;
			savedTimelineScroll = 0;
		}
	});

	// Live-updating "time ago" ticker
	let now = $state(Date.now());
	$effect(() => {
		if (!panelOpen) return;
		const interval = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(interval);
	});

	// ── Waiting-for-response indicator ──

	let waitingForResponse = $state(false);
	let lastMessageCountAtSend = $state(0);

	// Count only agent (assistant) messages — user messages must not clear the indicator
	function agentMessageCount(): number {
		if (drillDown) return drillMessages.filter(m => m.role === 'assistant').length;
		return timelineEntries.filter(e => e.agentName !== '__user__').length;
	}

	// Clear waitingForResponse when new agent messages arrive (via auto-refresh)
	$effect(() => {
		if (!waitingForResponse) return;
		if (agentMessageCount() > lastMessageCountAtSend) {
			waitingForResponse = false;
		}
	});

	// Also clear when panel closes or view changes
	$effect(() => {
		if (!panelOpen) waitingForResponse = false;
	});

	// ── Chat input ──

	/** Resolve the target sub-conversation ID(s) for a user message. */
	function getChatTargets(): string[] {
		if (drillDown?.subConversationId) return [drillDown.subConversationId];
		if (overviewData?.orchestrator?.subConversationId) return [overviewData.orchestrator.subConversationId];
		// No orchestrator — broadcast to all member sub-conversations
		if (overviewData?.streams?.length) return overviewData.streams.map(s => s.subConversationId).filter(Boolean);
		return [];
	}

	async function sendTeamMessage(content: string) {
		const targets = getChatTargets();
		if (targets.length === 0) throw new Error("No targets available");
		const results = await Promise.all(targets.map(id =>
			userFetch(`/api/conversations/${id}/agent-chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content }),
			})
		));
		const failed = results.find(r => !r.ok);
		if (failed) {
			const err = await failed.json().catch(() => ({ error: 'Failed to send' }));
			throw new Error(err.error ?? 'Failed to send');
		}
		if (drillDown) {
			drillLoaded = false;
			await loadDrillDown();
			scrollDrillToBottom();
		} else {
			overviewLoaded = false;
			await loadOverview();
			scrollTimelineToBottom();
		}
		// Snapshot AFTER reload so user's own message is already counted
		lastMessageCountAtSend = agentMessageCount();
		waitingForResponse = true;
	}

	function scrollTimelineToBottom(behavior: ScrollBehavior = 'instant') {
		tick().then(() => {
			requestAnimationFrame(() => {
				timelineSentinel?.scrollIntoView({ behavior });
			});
		});
	}

	function scrollDrillToBottom(behavior: ScrollBehavior = 'instant') {
		tick().then(() => {
			requestAnimationFrame(() => {
				drillSentinel?.scrollIntoView({ behavior });
			});
		});
	}

	// Feed messages for drill-down: all except first task message
	let drillFeedMessages = $derived(drillMessages.filter((m, i) => !(i === 0 && m.role === 'user')));

</script>

<SwipeDrawer open={panelOpen} side="right" width="w-full md:w-[36rem]" onclose={() => { if (drillDown) { closeTeamDrillDown(); } else { closeTeamPanel(); } }} zIndex={50} ariaLabel="Team chat">
	<div class="flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
		{#if drillDown}
			<!-- ═══ View B: Agent drill-down ═══ -->

			<!-- Header -->
			<div class="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
				<button
					onclick={closeTeamDrillDown}
					class="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
				>
					<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
					</svg>
					Back to team
				</button>
				<div class="flex items-center gap-2 ml-1">
					<span class="h-2.5 w-2.5 rounded-full" style:background-color={agentColor(drillDown.agentName)}></span>
					<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">@{drillDown.agentName}</h2>
				</div>
				<div class="flex-1"></div>
				<button
					onclick={closeTeamPanel}
					class="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<!-- Task + Stats bar -->
			{#if drillLoaded}
				<div class="border-b border-[var(--color-border)] px-4 py-2">
					{#if drillTaskMessage}
						<div class="flex items-center justify-between">
							<div class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Task</div>
							{#if drillTaskMessage.createdAt}
								<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={drillTaskMessage.createdAt}>{timeAgo(drillTaskMessage.createdAt, now)}</span>
							{/if}
						</div>
						<p class="mt-1 text-xs text-[var(--color-text-secondary)]">{drillTaskMessage.content}</p>
					{/if}
					{#if drillAssistantMessages.length > 0}
						{@const firstTime = drillTaskMessage?.createdAt ?? drillAssistantMessages[0]?.createdAt}
						{@const lastTime = drillAssistantMessages[drillAssistantMessages.length - 1]?.createdAt}
						<div class="mt-2 flex gap-3 text-[10px] text-[var(--color-text-muted)]">
							<span>{drillAssistantMessages.length} turn{drillAssistantMessages.length !== 1 ? 's' : ''}</span>
							<span>{drillTotalToolCalls} tool call{drillTotalToolCalls !== 1 ? 's' : ''}</span>
							{#if firstTime && lastTime && firstTime !== lastTime}
								<span>total {timeDelta(firstTime, lastTime)}</span>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Turn-by-turn activity with interleaved user messages -->
			<div class="flex-1 overflow-y-auto p-4 space-y-2" bind:this={drillScrollContainer}>
				{#if drillLoading}
					<div class="text-xs text-[var(--color-text-muted)]">Loading agent activity...</div>
				{:else if drillMessages.length === 0}
					<div class="text-xs text-[var(--color-text-muted)]">No activity recorded</div>
				{:else}
					{@const drillColor = agentColor(drillDown.agentName)}
					{@const turnCounter = { n: 0 }}
					{#each drillFeedMessages as msg (msg.id)}
						{#if msg.role === 'user'}
							<!-- User chat bubble -->
							<div class="flex justify-end pt-2">
								<div class="max-w-[85%] rounded-lg bg-[var(--color-accent)]/15 border border-[var(--color-accent)]/20 px-3 py-2">
									<div class="flex items-center justify-between gap-2 mb-1">
										<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">You</span>
										<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={msg.createdAt}>{timeAgo(msg.createdAt, now)}</span>
									</div>
									<div class="text-sm text-[var(--color-text-primary)]">{msg.content}</div>
								</div>
							</div>
						{:else if msg.role === 'assistant'}
							{@const turnIdx = turnCounter.n++}
							{@const hasText = msg.content?.trim()}
							{@const hasTools = msg.toolCalls?.length > 0}

							<!-- Turn header -->
							<div class="flex items-center gap-2 pt-1" data-drill-turn={turnIdx}>
								<span class="text-[10px] font-medium text-[var(--color-text-muted)]">Turn {turnIdx + 1}</span>
								<div class="flex-1 border-t border-[var(--color-border)]"></div>
								<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={msg.createdAt}>{timeAgo(msg.createdAt, now)}</span>
								{#if hasTools && !hasText}
									<span class="text-[10px] text-[var(--color-text-muted)]">{msg.toolCalls.length} tool{msg.toolCalls.length !== 1 ? 's' : ''}</span>
								{/if}
							</div>

							<!-- Tool calls -->
							{#if hasTools}
								<div class="space-y-0.5">
									{#each msg.toolCalls as tc (tc.id)}
										<button
											class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-mono transition-colors hover:bg-white/5"
											onclick={() => toggleTool(tc.id)}
										>
											<span class="{toolStatusColor(tc.status)} text-[10px]">{toolStatusIcon(tc.status)}</span>
											<span class="text-[var(--color-text-secondary)]">{tc.toolName}</span>
											{#if tc.input}
												<span class="truncate text-[var(--color-text-muted)] max-w-[200px]">{formatInput(tc.input)}</span>
											{/if}
											{#if tc.durationMs > 0}
												<span class="ml-auto text-[var(--color-text-muted)]">{tc.durationMs}ms</span>
											{/if}
										</button>

										{#if expandedTools.has(tc.id)}
											<div class="ml-5 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-2 text-xs">
												{#if tc.input}
													<div class="mb-1">
														<span class="text-[var(--color-text-muted)]">Input:</span>
														<pre class="mt-0.5 whitespace-pre-wrap text-[var(--color-text-secondary)] max-h-40 overflow-y-auto">{JSON.stringify(tc.input, null, 2)}</pre>
													</div>
												{/if}
												{#if tc.outputSummary}
													<div>
														<span class="text-[var(--color-text-muted)]">Output:</span>
														<pre class="mt-0.5 whitespace-pre-wrap text-[var(--color-text-secondary)] max-h-40 overflow-y-auto">{tc.outputSummary}</pre>
													</div>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							{/if}

							<!-- Text response -->
							{#if hasText}
								<div class="text-sm rounded bg-[var(--color-surface-secondary)] p-3">
									<div class="mb-1 text-[10px] font-semibold uppercase tracking-wider" style:color={drillColor}>
										Response
									</div>
									<div class="text-[var(--color-text-primary)] prose-sm">
										<MarkdownRenderer content={msg.content} />
									</div>
								</div>
							{/if}
						{/if}
					{/each}
				{/if}

				{#if waitingForResponse}
					<div class="thinking-indicator">
						<span class="thinking-dot" style="animation-delay: 0ms"></span>
						<span class="thinking-dot" style="animation-delay: 200ms"></span>
						<span class="thinking-dot" style="animation-delay: 400ms"></span>
						<span class="thinking-label">
							{drillDown?.agentName ? `@${drillDown.agentName} is thinking` : 'Agent is thinking'}
						</span>
					</div>
				{/if}

				<div bind:this={drillSentinel} class="h-1"></div>
			</div>

			{#if drillDown?.subConversationId}
				<PanelChatInput
					placeholder="Send a message to @{drillDown.agentName}..."
					processing={teamProcessing}
					agentName={drillDown.agentName}
					agentColor={agentColor(drillDown.agentName)}
					scrollSentinel={drillSentinel}
					scrollContainer={drillScrollContainer}
					onsubmit={sendTeamMessage}
				/>
			{/if}
		{:else}
			<!-- ═══ View A: Team overview ═══ -->

			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
				<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">Team: {teamName ?? 'Unknown'}</h2>
				<button
					onclick={closeTeamPanel}
					class="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<!-- Chronological timeline -->
			<div class="flex-1 overflow-y-auto p-4 space-y-2" bind:this={timelineEl}>
				{#if overviewLoading}
					<div class="text-xs text-[var(--color-text-muted)]">Loading team data...</div>
				{:else if !overviewData}
					<div class="text-xs text-[var(--color-text-muted)]">No team data available</div>
				{:else if timelineEntries.length === 0}
					<div class="text-xs text-[var(--color-text-muted)]">No activity yet</div>
				{:else}
					{#each timelineEntries as entry, idx (entry.message.id)}
						{#if entry.agentName === '__user__'}
							<!-- User chat bubble -->
							<div class="flex justify-end pt-2">
								<div class="max-w-[85%] rounded-lg bg-[var(--color-accent)]/15 border border-[var(--color-accent)]/20 px-3 py-2">
									<div class="flex items-center justify-between gap-2 mb-1">
										<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">You</span>
										<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={entry.message.createdAt}>{timeAgo(entry.message.createdAt, now)}</span>
									</div>
									<div class="text-sm text-[var(--color-text-primary)]">{entry.message.content}</div>
								</div>
							</div>
						{:else}
						{@const hasText = entry.message.content?.trim()}
						{@const hasTools = entry.message.toolCalls?.length > 0}
						{@const prevTime = idx > 0 ? timelineEntries[idx - 1]!.message.createdAt : entry.message.createdAt}

						<!-- Turn header -->
						<div class="flex items-center gap-2 pt-1">
							<span class="h-2 w-2 shrink-0 rounded-full" style:background-color={entry.color}></span>
							<button
								class="text-xs font-medium hover:underline"
								style:color={entry.color}
								onclick={() => drillDownWithScrollSave(entry.subConversationId, entry.agentName, entry.agentTurnIndex)}
								title="View @{entry.agentName} detail"
							>@{entry.agentName}</button>
							<span class="text-[10px] font-medium text-[var(--color-text-muted)]">Turn {entry.agentTurnIndex + 1}</span>
							{#if prevTime !== entry.message.createdAt}
								<span class="text-[10px] text-[var(--color-text-muted)] opacity-60">+{timeDelta(prevTime, entry.message.createdAt)}</span>
							{/if}
							<div class="flex-1 border-t border-[var(--color-border)]"></div>
							<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={entry.message.createdAt}>{timeAgo(entry.message.createdAt, now)}</span>
							{#if hasTools && !hasText}
								<span class="text-[10px] text-[var(--color-text-muted)]">{entry.message.toolCalls.length} tool{entry.message.toolCalls.length !== 1 ? 's' : ''}</span>
							{/if}
						</div>

						<!-- Tool calls -->
						{#if hasTools}
							<div class="space-y-0.5">
								{#each entry.message.toolCalls as tc (tc.id)}
									<button
										class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-mono transition-colors hover:bg-white/5"
										onclick={() => toggleTool(tc.id)}
									>
										<span class="{toolStatusColor(tc.status)} text-[10px]">{toolStatusIcon(tc.status)}</span>
										<span class="text-[var(--color-text-secondary)]">{tc.toolName}</span>
										{#if tc.input}
											<span class="truncate text-[var(--color-text-muted)] max-w-[200px]">{formatInput(tc.input)}</span>
										{/if}
										{#if tc.durationMs > 0}
											<span class="ml-auto text-[var(--color-text-muted)]">{tc.durationMs}ms</span>
										{/if}
									</button>

									{#if expandedTools.has(tc.id)}
										<div class="ml-5 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-2 text-xs">
											{#if tc.input}
												<div class="mb-1">
													<span class="text-[var(--color-text-muted)]">Input:</span>
													<pre class="mt-0.5 whitespace-pre-wrap text-[var(--color-text-secondary)] max-h-40 overflow-y-auto">{JSON.stringify(tc.input, null, 2)}</pre>
												</div>
											{/if}
											{#if tc.outputSummary}
												<div>
													<span class="text-[var(--color-text-muted)]">Output:</span>
													<pre class="mt-0.5 whitespace-pre-wrap text-[var(--color-text-secondary)] max-h-40 overflow-y-auto">{tc.outputSummary}</pre>
												</div>
											{/if}
										</div>
									{/if}
								{/each}
							</div>
						{/if}

						<!-- Text response -->
						{#if hasText}
							<div class="text-sm rounded bg-[var(--color-surface-secondary)] p-3">
								<div class="mb-1 text-[10px] font-semibold uppercase tracking-wider" style:color={entry.color}>
									Response
								</div>
								<div class="text-[var(--color-text-primary)] prose-sm">
									<MarkdownRenderer content={entry.message.content} />
								</div>
							</div>
						{/if}
						{/if}
					{/each}
				{/if}

				{#if waitingForResponse}
					<div class="thinking-indicator">
						<span class="thinking-dot" style="animation-delay: 0ms"></span>
						<span class="thinking-dot" style="animation-delay: 200ms"></span>
						<span class="thinking-dot" style="animation-delay: 400ms"></span>
						<span class="thinking-label">Agents are thinking</span>
					</div>
				{/if}

				<div bind:this={timelineSentinel} class="h-1"></div>
			</div>

			{#if getChatTargets().length > 0}
				<PanelChatInput
					placeholder="Send a message to the team..."
					processing={teamProcessing}
					agentName={teamName ?? undefined}
					scrollSentinel={timelineSentinel}
					scrollContainer={timelineEl}
					onsubmit={sendTeamMessage}
				/>
			{/if}
		{/if}
	</div>
</SwipeDrawer>

<style>
	.thinking-indicator {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 4px;
	}
	.thinking-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-text-muted);
		animation: thinking-bounce 1.4s ease-in-out infinite;
	}
	.thinking-label {
		margin-left: 6px;
		font-size: 11px;
		color: var(--color-text-muted);
	}
	@keyframes thinking-bounce {
		0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
		40% { opacity: 1; transform: scale(1); }
	}
</style>

