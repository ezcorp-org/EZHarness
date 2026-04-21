<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { invokeInlineTool } from "$lib/invoke-inline-tool.js";
	import CopyButton from "./CopyButton.svelte";
	import { parseTaskOutput, getStatusBadge } from "./utils.js";

	let { toolCall, conversationId, messageId, onsendmessage }: { toolCall: ToolCallState; conversationId?: string; messageId?: string; onsendmessage?: (message: string) => void } = $props();

	let task = $derived(parseTaskOutput(toolCall.output));

	let rawOutput = $derived.by((): string => {
		if (toolCall.output != null) {
			return typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2);
		}
		// Fallback: reconstruct from parsed task
		if (task) return JSON.stringify(task, null, 2);
		return '';
	});

	let badge = $derived(task ? getStatusBadge(task.status) : null);

	let canAct = $derived(!!conversationId && toolCall.status === 'complete' && task != null);

	// Edit state
	let editing = $state(false);
	let editTitle = $state('');
	let editDescription = $state('');

	// Finish state
	let finishing = $state(false);
	let finishSummary = $state('');

	let actionLoading = $state(false);

	function startEditing() {
		editTitle = task?.title ?? '';
		editDescription = task?.description ?? '';
		editing = true;
	}

	function handleStart() {
		if (!conversationId || !task?.id || actionLoading) return;
		actionLoading = true;
		invokeInlineTool({
			conversationId,
			extensionName: 'task-stack',
			toolName: 'start-task',
			input: { taskId: task.id },
			messageId,
		});
		// Send task context to the AI
		const desc = task.description ? `\n\n${task.description}` : '';
		onsendmessage?.(`Work on task: **${task.title}**${desc}`);
		actionLoading = false;
	}

	function handleFinish() {
		if (!conversationId || !task?.id || actionLoading || !finishSummary.trim()) return;
		actionLoading = true;
		invokeInlineTool({
			conversationId,
			extensionName: 'task-stack',
			toolName: 'finish-task',
			input: { taskId: task.id, summary: finishSummary.trim() },
			messageId,
		});
		finishing = false;
		finishSummary = '';
		actionLoading = false;
	}

	function handleUpdate() {
		if (!conversationId || !task?.id || actionLoading) return;
		const input: Record<string, unknown> = { taskId: task.id };
		if (editTitle.trim() && editTitle.trim() !== task.title) input.title = editTitle.trim();
		if (editDescription.trim() !== (task.description ?? '')) input.description = editDescription.trim();
		if (Object.keys(input).length <= 1) { editing = false; return; }
		actionLoading = true;
		invokeInlineTool({
			conversationId,
			extensionName: 'task-stack',
			toolName: 'update-task',
			input,
			messageId,
		});
		editing = false;
		actionLoading = false;
	}
</script>

<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<!-- Header -->
	<div class="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]">
		<svg class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
		</svg>
		<span class="text-xs font-medium text-[var(--color-text-secondary)]">{toolCall.toolName}</span>
		<div class="ml-auto">
			{#if rawOutput}
				<CopyButton text={rawOutput} />
			{/if}
		</div>
	</div>

	<!-- Content -->
	<div class="px-3 py-2">
		{#if toolCall.status === 'running'}
			<div class="flex items-center gap-2">
				<svg class="h-3.5 w-3.5 text-[var(--color-accent)] animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
				<span class="text-xs text-[var(--color-text-muted)]">Loading...</span>
			</div>
		{:else if task == null}
			<p class="text-xs text-[var(--color-text-muted)] italic">No task data</p>
		{:else}
			<div class="space-y-1.5">
				<!-- Title + Status -->
				<div class="flex items-start gap-2">
					<span class="text-sm font-medium text-[var(--color-text-primary)] flex-1">{task.title}</span>
					{#if badge}
						<span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium {badge.classes}">{badge.text}</span>
					{/if}
				</div>

				<!-- Description -->
				{#if task.description}
					<p class="text-xs text-[var(--color-text-secondary)]">{task.description}</p>
				{/if}

				<!-- Meta row -->
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-muted)]">
					{#if task.dueDate}
						<span>Due: {task.dueDate}</span>
					{/if}
					{#if task.readyForAgent}
						<span class="rounded-full bg-purple-500/20 px-1.5 py-0.5 text-purple-300">agent-ready</span>
					{/if}
					{#if task.completedAt}
						<span>Completed: {new Date(task.completedAt).toLocaleDateString()}</span>
					{/if}
				</div>

				<!-- Completion summary -->
				{#if task.completionSummary}
					<div class="mt-1 rounded bg-[var(--color-surface-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-secondary)]">
						{task.completionSummary}
					</div>
				{/if}

				<!-- Action buttons -->
				{#if canAct && task.id}
					<div class="mt-2 flex flex-wrap gap-2">
						{#if task.status === 'pending'}
							<button
								onclick={handleStart}
								disabled={actionLoading}
								class="rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
							>
								Start
							</button>
						{/if}
						{#if task.status === 'active'}
							<button
								onclick={() => { finishing = !finishing; finishSummary = ''; }}
								disabled={actionLoading}
								class="rounded bg-green-600 px-2.5 py-1 text-xs text-white hover:bg-green-500 transition-colors disabled:opacity-50"
							>
								Finish
							</button>
						{/if}
						{#if task.status !== 'completed'}
							<button
								onclick={startEditing}
								disabled={actionLoading}
								class="rounded bg-[var(--color-surface-secondary)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-border)] transition-colors disabled:opacity-50"
							>
								Edit
							</button>
						{/if}
					</div>
				{/if}

				<!-- Inline finish form -->
				{#if finishing}
					<form
						onsubmit={(e) => { e.preventDefault(); handleFinish(); }}
						class="mt-2 flex items-center gap-2"
					>
						<input
							type="text"
							bind:value={finishSummary}
							placeholder="Completion summary..."
							class="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-green-500 focus:outline-none"
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

				<!-- Inline edit form -->
				{#if editing}
					<form
						onsubmit={(e) => { e.preventDefault(); handleUpdate(); }}
						class="mt-2 space-y-2"
					>
						<input
							type="text"
							bind:value={editTitle}
							placeholder="Title..."
							class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-blue-500 focus:outline-none"
						/>
						<textarea
							bind:value={editDescription}
							placeholder="Description..."
							rows="2"
							class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-blue-500 focus:outline-none resize-y"
						></textarea>
						<div class="flex gap-2">
							<button
								type="submit"
								disabled={actionLoading}
								class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
							>
								Save
							</button>
							<button
								type="button"
								onclick={() => (editing = false)}
								class="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
							>
								Cancel
							</button>
						</div>
					</form>
				{/if}
			</div>
		{/if}
	</div>
</div>
