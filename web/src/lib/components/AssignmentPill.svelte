<script lang="ts">
	import type { TaskAssignment } from "$lib/stores.svelte.js";
	import { agentColor } from "$lib/agent-color.js";
	import { formatDuration } from "$lib/format-duration.js";

	let {
		assignment,
		now,
		starting = false,
		stopping = false,
		blocked = false,
		blockedBy = [],
		onstart,
		onstop,
		onclick,
	}: {
		assignment: TaskAssignment;
		now: number;
		starting?: boolean;
		/** True while a stop request is in-flight — disables the stop button + swaps the icon for a spinner. */
		stopping?: boolean;
		/**
		 * True when the parent task has unsatisfied dependencies. Disables
		 * the start button so users don't manually kick off a task that
		 * the backend will reject with a 409.
		 */
		blocked?: boolean;
		/** Titles of the prerequisite tasks — shown in the start-button tooltip. */
		blockedBy?: string[];
		onstart?: () => void;
		/** Fires on Stop-button click while the assignment is running. Parent should cancel the run + reset state. */
		onstop?: () => void;
		onclick?: () => void;
	} = $props();

	/** Resume vs Start: an `assigned` assignment that already has a subConversationId
	 *  is coming off a prior run (via the Stop button) — present it as Resume. */
	let isResume = $derived(assignment.status === "assigned" && !!assignment.subConversationId);

	let color = $derived(agentColor(assignment.agentName));
	let r = $derived(parseInt(color.slice(1, 3), 16));
	let g = $derived(parseInt(color.slice(3, 5), 16));
	let b = $derived(parseInt(color.slice(5, 7), 16));

	let elapsed = $derived.by(() => {
		if (assignment.status !== "running" || !assignment.startedAt) return null;
		return formatDuration(now - Date.parse(assignment.startedAt));
	});

	let isClickable = $derived(
		(assignment.status === "assigned" && !!onstart) ||
		(assignment.status !== "assigned" && !!onclick)
	);
</script>

<span
	class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium transition-colors"
	class:cursor-pointer={isClickable}
	class:hover:brightness-125={isClickable}
	style:border-color={color}
	style:background="rgba({r}, {g}, {b}, 0.1)"
>
	<!-- Status indicator -->
	{#if assignment.status === "assigned"}
		<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400"></span>
	{:else if assignment.status === "running"}
		<span class="relative flex h-1.5 w-1.5 shrink-0">
			<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75"></span>
			<span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-400"></span>
		</span>
	{:else if assignment.status === "completed"}
		<svg class="h-2.5 w-2.5 shrink-0 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
		</svg>
	{:else}
		<svg class="h-2.5 w-2.5 shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
		</svg>
	{/if}

	<!-- Agent name + optional team indicator -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span
		style:color={color}
		onclick={assignment.status === "assigned" ? undefined : onclick}
	>
		@{assignment.agentName}{#if assignment.isTeam}<span class="ml-0.5 opacity-60" title="Team">
			<svg class="inline h-2 w-2" fill="currentColor" viewBox="0 0 20 20">
				<path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906zM10 12a5 5 0 015 5v3H5v-3a5 5 0 015-5z" />
			</svg></span>
		{/if}
	</span>

	<!-- Elapsed timer when running -->
	{#if elapsed}
		<span class="tabular-nums text-[var(--color-text-muted)]">{elapsed}</span>
	{/if}

	<!-- Start button / spinner when assigned -->
	{#if assignment.status === "assigned" && onstart}
		{#if starting}
			<span class="ml-0.5 animate-spin h-2.5 w-2.5">
				<svg class="h-2.5 w-2.5" style:color={color} fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3">
					<path stroke-linecap="round" d="M12 3a9 9 0 019 9" />
				</svg>
			</span>
		{:else if blocked}
			<!-- Disabled start button: blocked by unsatisfied prerequisites.
			     Rendered as a lock icon, NOT wired to onstart, with a tooltip
			     naming the blocking tasks so the user understands why. -->
			<span
				class="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 cursor-not-allowed opacity-50"
				title={blockedBy.length > 0
					? `Waiting for prerequisites: ${blockedBy.join(", ")}`
					: "Waiting for prerequisites to complete"}
				aria-disabled="true"
				data-testid="assignment-start-blocked"
			>
				<svg class="h-2 w-2 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
				</svg>
			</span>
		{:else}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span
				class="ml-0.5 cursor-pointer rounded-full p-0.5 transition-colors hover:bg-white/10"
				onclick={(e) => { e.stopPropagation(); onstart?.(); }}
				title={isResume ? "Resume assignment" : "Start assignment"}
				role="button"
				tabindex="0"
			>
				<svg class="h-2 w-2" style:color={color} fill="currentColor" viewBox="0 0 20 20">
					<path d="M6.3 2.841A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
				</svg>
			</span>
		{/if}
	{/if}

	<!-- Stop button (only while running) -->
	{#if assignment.status === "running" && onstop}
		{#if stopping}
			<span class="ml-0.5 animate-spin h-2.5 w-2.5">
				<svg class="h-2.5 w-2.5" style:color={color} fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3">
					<path stroke-linecap="round" d="M12 3a9 9 0 019 9" />
				</svg>
			</span>
		{:else}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span
				class="ml-0.5 cursor-pointer rounded-full p-0.5 transition-colors hover:bg-red-500/20"
				onclick={(e) => { e.stopPropagation(); onstop?.(); }}
				title="Stop assignment (preserves context for resume)"
				role="button"
				tabindex="0"
			>
				<svg class="h-2 w-2 text-red-300" fill="currentColor" viewBox="0 0 20 20">
					<rect x="4" y="4" width="12" height="12" rx="1" />
				</svg>
			</span>
		{/if}
	{/if}
</span>
