<script lang="ts">
	import type { TaskSnapshot, TaskPanelTask } from "$lib/stores.svelte.js";
	import { slide } from "svelte/transition";
	import { getStatusIcon, getStatusColor } from "./tool-cards/utils.js";
	import AssignmentPill from "./AssignmentPill.svelte";
	import AssignmentPicker from "./AssignmentPicker.svelte";
	import { formatDuration } from "$lib/format-duration.js";
	import { addToast } from "$lib/toast.svelte.js";

	let {
		snapshot,
		conversationId,
		selectedModel,
		onsendmessage,
		ontaskclick,
		onteamclick,
	}: {
		snapshot: TaskSnapshot;
		conversationId: string;
		selectedModel?: { provider: string; model: string } | null;
		onsendmessage?: (message: string) => void;
		ontaskclick?: (task: TaskPanelTask) => void;
		onteamclick?: (agentConfigId: string, teamName: string) => void;
	} = $props();

	// Inline assignment picker state
	let pickerOpenForTaskId = $state<string | null>(null);
	let pickerAnchorEl = $state<HTMLElement | null>(null);
	let startingAssignmentId = $state<string | null>(null);
	let retryingTaskId = $state<string | null>(null);

	// Sort tasks by priority
	let tasks = $derived([...snapshot.tasks].sort((a, b) => a.priority - b.priority));

	let completedCount = $derived(tasks.filter((t) => t.status === "completed").length);
	let failedCount = $derived(tasks.filter((t) => t.status === "failed").length);
	let totalCount = $derived(tasks.length);
	let activeTask = $derived(tasks.find((t) => t.id === snapshot.activeTaskId) ?? tasks.find((t) => t.status === "active"));
	let progressPercent = $derived(totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0);
	let allDone = $derived(totalCount > 0 && tasks.every((t) => t.status === "completed" || t.status === "failed"));

	// Expanded by default when tasks exist (Claude Code behavior)
	let expanded = $state(true);
	// Track which tasks have their subtasks expanded
	let expandedSubtasks = $state<Record<string, boolean>>({});

	// Reactive clock for the active-task count-up timer.
	// Ticks once per second ONLY while a task is active — pauses otherwise
	// so completed lists don't keep spinning a timer for no reason.
	let now = $state(Date.now());
	$effect(() => {
		if (!activeTask) return;
		now = Date.now();
		const interval = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(interval);
	});

	/**
	 * Return the duration to display for a task:
	 * - active: live count-up from startedAt to now
	 * - completed: total elapsed from startedAt to completedAt
	 * - failed: total elapsed from startedAt to failedAt
	 * - pending: null (no timer shown)
	 */
	function taskDuration(task: TaskPanelTask, nowMs: number): string | null {
		if (!task.startedAt) return null;
		const start = Date.parse(task.startedAt);
		if (Number.isNaN(start)) return null;
		let end: number;
		if (task.status === "active") {
			end = nowMs;
		} else if (task.status === "completed" && task.completedAt) {
			end = Date.parse(task.completedAt);
		} else if (task.status === "failed" && task.failedAt) {
			end = Date.parse(task.failedAt);
		} else {
			return null;
		}
		if (Number.isNaN(end)) return null;
		return formatDuration(end - start);
	}

	function toggleSubtasks(taskId: string) {
		expandedSubtasks = {
			...expandedSubtasks,
			[taskId]: !expandedSubtasks[taskId],
		};
	}

	function handleTaskClick(task: TaskPanelTask) {
		if (task.assignments?.length > 0 && ontaskclick) {
			ontaskclick(task);
			return;
		}
		if (task.status !== "pending" || !onsendmessage) return;
		const desc = task.description ? `\n\n${task.description}` : "";
		onsendmessage(`Work on task: **${task.title}**${desc}`);
	}

	async function retryTask(taskId: string) {
		retryingTaskId = taskId;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/tasks/${taskId}/retry`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...(selectedModel ? { provider: selectedModel.provider, model: selectedModel.model } : {}),
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const msg = data.error ?? res.statusText;
				console.error("Failed to retry task:", res.status, msg);
				addToast({ type: "error", message: `Failed to retry task: ${msg}` });
			}
		} catch (err) {
			console.error("Failed to retry task:", err);
			addToast({ type: "error", message: "Failed to retry task" });
		}
		retryingTaskId = null;
	}

	async function startAssignment(taskId: string, assignmentId: string) {
		startingAssignmentId = assignmentId;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/tasks/${taskId}/assignments/${assignmentId}/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...(selectedModel ? { provider: selectedModel.provider, model: selectedModel.model } : {}),
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const msg = data.error ?? res.statusText;
				console.error("Failed to start assignment:", res.status, msg);
				addToast({ type: "error", message: `Failed to start assignment: ${msg}` });
			}
		} catch (err) {
			console.error("Failed to start assignment:", err);
			addToast({ type: "error", message: "Failed to start assignment" });
		}
		startingAssignmentId = null;
	}

	// Status dot color for the collapsed progress indicator
	function dotColor(status: string): string {
		switch (status) {
			case "completed":
				return "bg-green-500";
			case "active":
				return "bg-blue-400 animate-pulse";
			case "failed":
				return "bg-red-500";
			default:
				return "bg-[var(--color-surface-tertiary)] border border-[var(--color-border)]";
		}
	}

	function durationBadgeClass(status: string): string {
		switch (status) {
			case "active":
				return "bg-blue-500/20 text-blue-300";
			case "completed":
				return "bg-green-500/15 text-green-300/80";
			case "failed":
				return "bg-red-500/15 text-red-300/80";
			default:
				return "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]";
		}
	}

	/**
	 * Lookup table of prerequisite tasks per task. Used both for the
	 * "Waiting for: ..." badge and to propagate the blocked state into
	 * `AssignmentPill` so the start button is disabled while blocked.
	 *
	 * Mirrors the backend `isBlocked` / `unsatisfiedDeps` helpers — kept
	 * derived (not stored) so the wire format stays minimal.
	 */
	let tasksById = $derived(new Map(snapshot.tasks.map((t) => [t.id, t])));
	function unsatisfiedDepsFor(task: TaskPanelTask): TaskPanelTask[] {
		if (!task.dependsOn || task.dependsOn.length === 0) return [];
		const out: TaskPanelTask[] = [];
		for (const depId of task.dependsOn) {
			const dep = tasksById.get(depId);
			if (!dep) continue; // unknown dep — treat as satisfied
			if (dep.status !== "completed") out.push(dep);
		}
		return out;
	}
	function isTaskBlocked(task: TaskPanelTask): boolean {
		if (task.status !== "pending") return false;
		return unsatisfiedDepsFor(task).length > 0;
	}
</script>

<div class="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
	<!-- Collapsed header bar (always visible) -->
	<button
		type="button"
		onclick={() => (expanded = !expanded)}
		class="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--color-surface-secondary)]/50"
		aria-label={expanded ? "Collapse task panel" : "Expand task panel"}
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

		<!-- Label -->
		<span class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
			Tasks
		</span>

		<!-- Counter -->
		<span class="text-[10px] tabular-nums text-[var(--color-text-secondary)]">
			{completedCount}/{totalCount}
			{#if failedCount > 0}
				<span class="text-red-400">· {failedCount} failed</span>
			{/if}
		</span>

		<!-- Progress dots -->
		<div class="flex items-center gap-1">
			{#each tasks.slice(0, 12) as task (task.id)}
				<span class="h-1.5 w-1.5 shrink-0 rounded-full {dotColor(task.status)}" title={task.title}></span>
			{/each}
			{#if tasks.length > 12}
				<span class="text-[9px] text-[var(--color-text-muted)]">+{tasks.length - 12}</span>
			{/if}
		</div>

		<!-- Active task title + live timer (shown when collapsed) -->
		{#if !expanded && activeTask}
			<span class="ml-2 truncate text-xs text-[var(--color-text-secondary)]" title={activeTask.title}>
				{activeTask.title}
			</span>
			{#if taskDuration(activeTask, now)}
				<span
					class="shrink-0 rounded-full bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-blue-300"
					title="Elapsed time for the active task"
				>
					{taskDuration(activeTask, now)}
				</span>
			{/if}
		{/if}

		<!-- Progress bar (right side) -->
		<div class="ml-auto flex items-center gap-2">
			<div class="h-1 w-20 overflow-hidden rounded-full bg-[var(--color-surface-tertiary)]">
				<div
					class="h-full rounded-full transition-all duration-300"
					class:bg-green-500={!allDone || failedCount === 0}
					class:bg-amber-500={allDone && failedCount > 0}
					style:width="{progressPercent}%"
				></div>
			</div>
		</div>
	</button>

	<!-- Expanded task list -->
	{#if expanded}
		<div class="max-h-80 overflow-y-auto border-t border-[var(--color-border)]" transition:slide={{ duration: 150 }}>
			{#each tasks as task (task.id)}
				{@const isActive = task.status === "active"}
				{@const hasSubtasks = task.subtasks.length > 0}
				{@const subtasksOpen = !!expandedSubtasks[task.id]}
				{@const completedSubtasks = task.subtasks.filter((s) => s.completed).length}
				{@const blockedBy = unsatisfiedDepsFor(task)}
				{@const blocked = isTaskBlocked(task)}

				<div
					class="group border-b border-[var(--color-border)]/50 last:border-b-0"
					class:bg-blue-500={isActive}
					class:bg-opacity-5={isActive}
					class:opacity-60={blocked}
					data-task-id={task.id}
					data-blocked={blocked ? "true" : "false"}
				>
					<!-- Task row -->
					<div class="flex items-start gap-2 px-4 py-1.5" class:border-l-2={isActive} class:border-blue-400={isActive}>
						<!-- Status icon -->
						<span class="mt-0.5 shrink-0 text-sm leading-none {getStatusColor(task.status)}">
							{getStatusIcon(task.status)}
						</span>

						<!-- Subtask toggle chevron (if applicable) -->
						{#if hasSubtasks}
							<button
								type="button"
								onclick={() => toggleSubtasks(task.id)}
								class="mt-0.5 shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
								aria-label="Toggle subtasks"
							>
								<svg
									class="h-2.5 w-2.5 transition-transform"
									class:rotate-90={subtasksOpen}
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									stroke-width="3"
								>
									<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
								</svg>
							</button>
						{/if}

						<!-- Title (clickable for pending tasks) -->
						<button
							type="button"
							onclick={() => handleTaskClick(task)}
							disabled={task.status !== "pending" || !onsendmessage}
							class="flex-1 text-left text-xs leading-snug transition-colors"
							class:cursor-default={task.status !== "pending"}
							class:text-[var(--color-text-primary)]={task.status !== "completed"}
							class:text-[var(--color-text-secondary)]={task.status === "completed"}
							class:line-through={task.status === "completed"}
							class:hover:text-blue-400={task.status === "pending" && !!onsendmessage}
						>
							{task.title}
							{#if hasSubtasks}
								<span class="ml-1 text-[10px] text-[var(--color-text-muted)]">
									({completedSubtasks}/{task.subtasks.length})
								</span>
							{/if}
						</button>

						<!-- Agent badge (legacy single-agent) -->
						{#if task.agentName && !(task.assignments?.length > 0)}
							<span
								class="shrink-0 rounded-full bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-medium text-purple-300"
								title="Assigned to {task.agentName}"
							>
								@{task.agentName}
							</span>
						{/if}

						<!-- Assignment pills -->
						{#if task.assignments?.length > 0}
							<div class="flex flex-wrap gap-1 ml-1">
								{#each task.assignments as assignment (assignment.id)}
									<AssignmentPill
										{assignment}
										{now}
										starting={startingAssignmentId === assignment.id}
										{blocked}
										blockedBy={blockedBy.map((t) => t.title)}
										onstart={() => startAssignment(task.id, assignment.id)}
										onclick={() => {
											if (assignment.isTeam && onteamclick) {
												onteamclick(assignment.agentConfigId, assignment.agentName);
											} else if (assignment.subConversationId && ontaskclick) {
												ontaskclick(task);
											}
										}}
									/>
								{/each}
							</div>
						{/if}

						<!-- Assign button (+) with inline picker -->
						<span class="shrink-0">
							<button
								type="button"
								onclick={(e) => { pickerAnchorEl = e.currentTarget as HTMLElement; e.stopPropagation(); pickerOpenForTaskId = pickerOpenForTaskId === task.id ? null : task.id; }}
								class="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 hover:text-blue-400 transition-opacity"
								class:opacity-100={pickerOpenForTaskId === task.id}
								class:text-blue-400={pickerOpenForTaskId === task.id}
								title="Assign agent or team"
							>
								<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
								</svg>
							</button>
							{#if pickerOpenForTaskId === task.id}
								<AssignmentPicker
									open={true}
									anchor={pickerAnchorEl ?? undefined}
									{conversationId}
									taskId={task.id}
									onclose={() => { pickerOpenForTaskId = null; }}
								/>
							{/if}
						</span>

						<!-- Duration badge: live count-up for active, final time for completed/failed -->
						{#if taskDuration(task, now)}
							<span
								class="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium tabular-nums {durationBadgeClass(task.status)}"
								title={task.status === 'active'
									? 'Elapsed time (live)'
									: task.status === 'completed'
										? 'Total time to complete'
										: 'Total time before failure'}
							>
								{taskDuration(task, now)}
							</span>
						{/if}
					</div>

					<!-- Failure reason + retry (inline under task) -->
					{#if task.status === "failed"}
						<div class="flex items-start gap-2 px-4 pb-1 pl-9">
							{#if task.failureReason}
								<span class="flex-1 text-[10px] italic text-red-300/80">{task.failureReason}</span>
							{/if}
							<button
								type="button"
								onclick={() => retryTask(task.id)}
								disabled={retryingTaskId === task.id}
								class="shrink-0 rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-500/25 hover:text-red-200 transition-colors disabled:opacity-50"
								title="Reset failure state and re-run the assignment"
							>
								{retryingTaskId === task.id ? "Retrying…" : "↻ Retry"}
							</button>
						</div>
					{/if}

					<!-- Dependency status (inline under task) — shows which prerequisites
					     must complete before this task can run. Click a chip to scroll
					     to the blocking task (unsatisfiedDepsFor skips already-completed
					     prereqs so the list is always what's actually blocking). -->
					{#if blocked}
						<div
							class="flex flex-wrap items-center gap-1 px-4 pb-1 pl-9 text-[10px] text-[var(--color-text-muted)]"
							data-testid="blocked-badge"
						>
							<svg class="h-3 w-3 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
							</svg>
							<span>Waiting for:</span>
							{#each blockedBy as dep (dep.id)}
								<button
									type="button"
									class="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300/90 hover:bg-amber-500/25 hover:text-amber-200 transition-colors"
									title="Click to highlight {dep.title}"
									onclick={() => {
										const el = document.querySelector(`[data-task-id="${dep.id}"]`);
										if (el instanceof HTMLElement) {
											el.scrollIntoView({ behavior: "smooth", block: "center" });
											el.classList.add("ring-2", "ring-amber-400");
											setTimeout(() => el.classList.remove("ring-2", "ring-amber-400"), 1500);
										}
									}}
								>
									{dep.title}
								</button>
							{/each}
						</div>
					{/if}

					<!-- Completion summary on hover (only shown when row hovered) -->
					{#if task.status === "completed" && task.completionSummary}
						<div
							class="max-h-0 overflow-hidden px-4 pl-9 text-[10px] text-[var(--color-text-muted)] transition-all duration-200 group-hover:max-h-20 group-hover:pb-1"
						>
							{task.completionSummary}
						</div>
					{/if}

					<!-- Subtask checklist -->
					{#if hasSubtasks && subtasksOpen}
						<div class="pb-1 pl-9 pr-4" transition:slide={{ duration: 120 }}>
							{#each task.subtasks as subtask (subtask.id)}
								<div class="flex items-center gap-2 py-0.5 text-[11px]">
									<span
										class="inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border"
										class:border-green-400={subtask.completed}
										class:bg-green-500={subtask.completed}
										class:border-[var(--color-border)]={!subtask.completed}
									>
										{#if subtask.completed}
											<svg class="h-2 w-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="4">
												<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
											</svg>
										{/if}
									</span>
									<span
										class:text-[var(--color-text-muted)]={subtask.completed}
										class:line-through={subtask.completed}
										class:text-[var(--color-text-secondary)]={!subtask.completed}
									>
										{subtask.title}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
