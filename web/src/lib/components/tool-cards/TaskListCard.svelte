<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { invokeInlineTool } from "$lib/invoke-inline-tool.js";
	import CopyButton from "./CopyButton.svelte";
	import { parseListOutput, isStackList, getStatusColor, getStatusIcon } from "./utils.js";

	let { toolCall, conversationId, messageId, onsendmessage }: { toolCall: ToolCallState; conversationId?: string; messageId?: string; onsendmessage?: (message: string) => void } = $props();

	let items = $derived(parseListOutput(toolCall.output));

	let rawOutput = $derived.by((): string => {
		if (toolCall.output != null) {
			return typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2);
		}
		// Fallback: reconstruct from parsed items
		if (items.length > 0) return JSON.stringify(items, null, 2);
		return '';
	});

	let isStacks = $derived(isStackList(items));

	let canAct = $derived(!!conversationId && toolCall.status === 'complete');

	// Add Task state
	let addingTask = $state(false);
	let newTaskTitle = $state('');
	let actionLoading = $state(false);

	// Finish Task state
	let finishingTaskId = $state<string | null>(null);
	let finishSummary = $state('');

	function handleStartTask(task: { id?: string; title?: string; description?: string }) {
		if (!conversationId || actionLoading || !task.id) return;
		actionLoading = true;
		invokeInlineTool({
			conversationId,
			extensionName: 'task-stack',
			toolName: 'start-task',
			input: { taskId: task.id },
			messageId,
		});
		// Send task context to the AI so it starts working on it
		const desc = task.description ? `\n\n${task.description}` : '';
		onsendmessage?.(`Work on task: **${task.title}**${desc}`);
		actionLoading = false;
	}

	function handleFinishTask(taskId: string) {
		if (!conversationId || actionLoading || !finishSummary.trim()) return;
		actionLoading = true;
		invokeInlineTool({
			conversationId,
			extensionName: 'task-stack',
			toolName: 'finish-task',
			input: { taskId, summary: finishSummary.trim() },
			messageId,
		});
		finishingTaskId = null;
		finishSummary = '';
		actionLoading = false;
	}

	function handleAddTask() {
		if (!conversationId || actionLoading || !newTaskTitle.trim()) return;
		actionLoading = true;
		invokeInlineTool({
			conversationId,
			extensionName: 'task-stack',
			toolName: 'add-task',
			input: { title: newTaskTitle.trim() },
			messageId,
		});
		addingTask = false;
		newTaskTitle = '';
		actionLoading = false;
	}
</script>

<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<!-- Header -->
	<div class="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]">
		<svg class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
		</svg>
		<span class="text-xs font-medium text-[var(--color-text-secondary)]">{toolCall.toolName}</span>
		<span class="text-[10px] text-[var(--color-text-muted)]">
			{items.length} {isStacks ? 'stack' : 'task'}{items.length !== 1 ? 's' : ''}
		</span>
		<div class="ml-auto">
			{#if rawOutput}
				<CopyButton text={rawOutput} />
			{/if}
		</div>
	</div>

	<!-- List -->
	<div class="max-h-80 overflow-y-auto">
		{#if toolCall.status === 'running'}
			<div class="px-3 py-3 flex items-center gap-2">
				<svg class="h-3.5 w-3.5 text-[var(--color-accent)] animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
				<span class="text-xs text-[var(--color-text-muted)]">Loading...</span>
			</div>
		{:else if items.length === 0}
			<p class="px-3 py-2 text-xs text-[var(--color-text-muted)] italic">No items</p>
		{:else if isStacks}
			{#each items as stack}
				<div class="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-secondary)]/50">
					<span class="text-[var(--color-text-muted)]">📚</span>
					<span class="font-medium text-[var(--color-text-primary)]">{stack.name}</span>
				</div>
			{/each}
		{:else}
			{#each items as task}
				<div class="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-secondary)]/50">
					<span class="shrink-0 {getStatusColor(task.status)}">{getStatusIcon(task.status)}</span>
					<span class="truncate text-[var(--color-text-primary)]">{task.title}</span>
					{#if task.readyForAgent}
						<span class="shrink-0 rounded-full bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-300">agent</span>
					{/if}
					{#if task.dueDate}
						<span class="shrink-0 text-[10px] text-[var(--color-text-muted)]">{task.dueDate}</span>
					{/if}

					{#if canAct && !isStacks && task.id}
						<div class="ml-auto flex items-center gap-1 shrink-0">
							{#if task.status === 'pending'}
								<!-- Start button -->
								<button
									onclick={() => handleStartTask(task)}
									disabled={actionLoading}
									class="rounded p-0.5 text-[var(--color-text-muted)] hover:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
									title="Start task"
								>
									<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M5 3l14 9-14 9V3z" />
									</svg>
								</button>
							{:else if task.status === 'active'}
								<!-- Finish button -->
								<button
									onclick={() => { finishingTaskId = finishingTaskId === task.id ? null : (task.id ?? null); finishSummary = ''; }}
									disabled={actionLoading}
									class="rounded p-0.5 text-[var(--color-text-muted)] hover:text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-50"
									title="Finish task"
								>
									<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
									</svg>
								</button>
							{/if}
						</div>
					{:else if !task.dueDate}
						<span class="ml-auto"></span>
					{/if}
				</div>

				<!-- Inline finish summary input -->
				{#if finishingTaskId === task.id}
					<form
						onsubmit={(e) => { e.preventDefault(); handleFinishTask(task.id!); }}
						class="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-secondary)]/50 border-b border-[var(--color-border)]"
					>
						<input
							type="text"
							bind:value={finishSummary}
							placeholder="Completion summary..."
							class="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-green-500 focus:outline-none"
						/>
						<button
							type="submit"
							disabled={!finishSummary.trim() || actionLoading}
							class="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-500 transition-colors disabled:opacity-50"
						>
							Done
						</button>
					</form>
				{/if}
			{/each}
		{/if}
	</div>

	<!-- Add Task footer -->
	{#if canAct && !isStacks}
		<div class="border-t border-[var(--color-border)] px-3 py-1.5">
			{#if addingTask}
				<form
					onsubmit={(e) => { e.preventDefault(); handleAddTask(); }}
					class="flex items-center gap-2"
				>
					<input
						type="text"
						bind:value={newTaskTitle}
						placeholder="Task title..."
						class="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-blue-500 focus:outline-none"
					/>
					<button
						type="submit"
						disabled={!newTaskTitle.trim() || actionLoading}
						class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
					>
						Add
					</button>
					<button
						type="button"
						onclick={() => { addingTask = false; newTaskTitle = ''; }}
						class="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
					>
						Cancel
					</button>
				</form>
			{:else}
				<button
					onclick={() => (addingTask = true)}
					class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
				>
					+ Add Task
				</button>
			{/if}
		</div>
	{/if}
</div>
