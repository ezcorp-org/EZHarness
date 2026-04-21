<script lang="ts">
	import type { TaskPanelTask, TaskAssignment } from "$lib/stores.svelte.js";
	import { openTeamPanel } from "$lib/stores.svelte.js";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import { agentColor } from "$lib/agent-color.js";
	import { timeAgo, timeDelta } from "$lib/format-duration.js";
	import { toolStatusIcon, toolStatusColor, formatInput } from "$lib/tool-display.js";

	let {
		task,
		conversationId,
		open,
		onclose,
	}: {
		task: TaskPanelTask;
		conversationId: string;
		open: boolean;
		onclose: () => void;
	} = $props();

	interface ToolCallInfo {
		id: string;
		toolName: string;
		input: Record<string, unknown> | null;
		outputSummary: string | null;
		success: boolean;
		durationMs: number;
		status: string;
	}

	interface StreamMessage {
		id: string;
		role: string;
		content: string;
		createdAt: string;
		toolCalls: ToolCallInfo[];
	}

	interface AssignmentStream {
		assignmentId: string;
		agentName: string;
		subConversationId: string;
		status: string;
		messages: StreamMessage[];
	}

	let streams = $state<AssignmentStream[]>([]);
	let loading = $state(false);
	let loaded = $state(false);

	// Track which streams are expanded
	let expandedStreams = $state(new Set<string>());
	// Track which tool calls are expanded
	let expandedTools = $state(new Set<string>());

	function toggleStream(assignmentId: string) {
		const next = new Set(expandedStreams);
		if (next.has(assignmentId)) next.delete(assignmentId); else next.add(assignmentId);
		expandedStreams = next;
	}

	function toggleTool(id: string) {
		const next = new Set(expandedTools);
		if (next.has(id)) next.delete(id); else next.add(id);
		expandedTools = next;
	}

	function findAssignment(assignmentId: string): TaskAssignment | undefined {
		return task.assignments?.find(a => a.id === assignmentId);
	}

	async function loadMessages() {
		if (loaded || loading) return;
		loading = true;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/tasks/${task.id}/messages`);
			if (res.ok) {
				const data = await res.json();
				streams = data.streams ?? [];
				expandedStreams = new Set(streams.map(s => s.assignmentId));
			}
		} catch { /* silent */ }
		loaded = true; // Mark loaded even on error to prevent fetch loops
		loading = false;
	}

	// Reset when task changes, load when opened
	let prevTaskId = $state('');
	$effect(() => {
		if (task.id !== prevTaskId) {
			prevTaskId = task.id;
			streams = [];
			loaded = false;
			expandedStreams = new Set();
			expandedTools = new Set();
		}
		if (open && !loaded) loadMessages();
	});

	function statusBadge(status: string): { text: string; classes: string } {
		switch (status) {
			case 'running':
				return { text: 'Running', classes: 'bg-blue-500/20 text-blue-400' };
			case 'complete':
			case 'completed':
				return { text: 'Complete', classes: 'bg-green-500/20 text-green-400' };
			case 'error':
			case 'failed':
				return { text: 'Failed', classes: 'bg-red-500/20 text-red-400' };
			default:
				return { text: status, classes: 'bg-gray-500/20 text-gray-400' };
		}
	}

	function taskStatusBadge(status: string): { text: string; classes: string } {
		switch (status) {
			case 'pending':
				return { text: 'Pending', classes: 'bg-gray-500/20 text-gray-400' };
			case 'active':
				return { text: 'Active', classes: 'bg-blue-500/20 text-blue-400' };
			case 'completed':
				return { text: 'Completed', classes: 'bg-green-500/20 text-green-400' };
			case 'failed':
				return { text: 'Failed', classes: 'bg-red-500/20 text-red-400' };
			default:
				return { text: status, classes: 'bg-gray-500/20 text-gray-400' };
		}
	}

	// Live-updating "time ago" ticker
	let now = $state(Date.now());
	$effect(() => {
		if (!open) return;
		const interval = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(interval);
	});

	function handleAgentPillClick(stream: AssignmentStream) {
		const assignment = findAssignment(stream.assignmentId);
		if (assignment?.isTeam) {
			openTeamPanel(conversationId, assignment.agentConfigId, stream.agentName);
		} else {
			toggleStream(stream.assignmentId);
		}
	}

	let totalAssignments = $derived(task.assignments?.length ?? 0);
	let tsBadge = $derived(taskStatusBadge(task.status));
</script>

<SwipeDrawer {open} side="right" width="w-full md:w-[32rem]" {onclose} ariaLabel="Task logs">
	<div class="flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
			<div class="flex items-center gap-2 min-w-0">
				<h2 class="truncate text-sm font-semibold text-[var(--color-text-primary)]">{task.title}</h2>
				<span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] {tsBadge.classes}">{tsBadge.text}</span>
			</div>
			<div class="flex items-center gap-2 shrink-0">
				{#if totalAssignments > 0}
					<span class="text-[10px] text-[var(--color-text-muted)]">
						{totalAssignments} assignment{totalAssignments !== 1 ? 's' : ''}
					</span>
				{/if}
				<button
					onclick={onclose}
					class="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		</div>

		<!-- Description -->
		{#if task.description}
			<div class="border-b border-[var(--color-border)] px-4 py-2">
				<div class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Description</div>
				<p class="mt-1 text-xs text-[var(--color-text-secondary)]">{task.description}</p>
			</div>
		{/if}

		<!-- Agent streams -->
		<div class="flex-1 overflow-y-auto p-4 space-y-3">
			{#if loading}
				<div class="text-xs text-[var(--color-text-muted)]">Loading task logs...</div>
			{:else if streams.length === 0}
				<div class="text-xs text-[var(--color-text-muted)]">
					{task.status === 'active' ? 'Waiting for agent activity...' : 'No agent activity recorded'}
				</div>
			{:else}
				{#each streams as stream (stream.assignmentId)}
					{@const color = agentColor(stream.agentName)}
					{@const badge = statusBadge(stream.status)}
					{@const isExpanded = expandedStreams.has(stream.assignmentId)}
					{@const assignment = findAssignment(stream.assignmentId)}
					{@const assistantMsgs = stream.messages.filter(m => m.role === 'assistant')}
					{@const taskMsg = stream.messages.find(m => m.role === 'user')}

					<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
						<!-- Stream header -->
						<button
							class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5"
							onclick={() => handleAgentPillClick(stream)}
						>
							<span class="h-2 w-2 shrink-0 rounded-full" style:background-color={color}></span>
							<span class="text-xs font-medium text-[var(--color-text-primary)]" style:color={color}>
								@{stream.agentName}
							</span>
							{#if assignment?.isTeam}
								<span class="text-[10px] text-[var(--color-text-muted)]">(team)</span>
							{/if}
							<span class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] {badge.classes}">{badge.text}</span>
							<span class="ml-auto text-[10px] text-[var(--color-text-muted)]">
								{assistantMsgs.length} turn{assistantMsgs.length !== 1 ? 's' : ''}
							</span>
							<svg
								class="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform {isExpanded ? 'rotate-180' : ''}"
								fill="none" stroke="currentColor" viewBox="0 0 24 24"
							>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
							</svg>
						</button>

						<!-- Expanded stream content -->
						{#if isExpanded}
							<div class="border-t border-[var(--color-border)] px-3 py-2 space-y-2">
								{#if taskMsg}
									<div class="text-[10px] text-[var(--color-text-muted)]">
										<span class="font-medium uppercase tracking-wider">Task</span>
										<p class="mt-0.5 text-xs text-[var(--color-text-secondary)]">{taskMsg.content}</p>
									</div>
								{/if}

								{#if assistantMsgs.length === 0}
									<div class="text-xs text-[var(--color-text-muted)]">
										{stream.status === 'running' ? 'Agent is working...' : 'No activity recorded'}
									</div>
								{:else}
									{#each assistantMsgs as msg, turnIdx (msg.id)}
										{@const hasText = msg.content?.trim()}
										{@const hasTools = msg.toolCalls?.length > 0}
										{@const prevTime = turnIdx > 0 ? assistantMsgs[turnIdx - 1]!.createdAt : (taskMsg?.createdAt ?? msg.createdAt)}

										<!-- Turn header -->
										<div class="flex items-center gap-2 pt-1">
											<span class="text-[10px] font-medium text-[var(--color-text-muted)]">Turn {turnIdx + 1}</span>
											{#if prevTime !== msg.createdAt}
												<span class="text-[10px] text-[var(--color-text-muted)] opacity-60">+{timeDelta(prevTime, msg.createdAt)}</span>
											{/if}
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
														<div class="ml-5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs">
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
											<div class="text-sm rounded bg-[var(--color-surface)] p-3">
												<div class="mb-1 text-[10px] font-semibold uppercase tracking-wider" style:color={color}>
													Response
												</div>
												<div class="text-[var(--color-text-primary)] prose-sm">
													<MarkdownRenderer content={msg.content} />
												</div>
											</div>
										{/if}
									{/each}
								{/if}

								{#if stream.status === 'running'}
									<div class="flex items-center gap-2 pt-2 text-xs text-[var(--color-text-muted)]">
										<span class="relative flex h-2 w-2">
											<span class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style:background-color={color}></span>
											<span class="relative inline-flex h-2 w-2 rounded-full" style:background-color={color}></span>
										</span>
										Agent is working...
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
</SwipeDrawer>
