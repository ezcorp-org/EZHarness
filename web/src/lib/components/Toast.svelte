<script lang="ts">
	import { fly } from "svelte/transition";
	import { toastStore, type ToastData } from "$lib/toast.svelte.js";

	let { toast, onclose }: { toast: ToastData; onclose: (id: string) => void } = $props();

	const iconColors: Record<ToastData['type'], string> = {
		success: 'text-green-500',
		error: 'text-red-500',
		warning: 'text-amber-500',
		info: 'text-blue-500',
	};

	const borderColors: Record<ToastData['type'], string> = {
		success: 'border-green-500/30',
		error: 'border-red-500/30',
		warning: 'border-amber-500/30',
		info: 'border-blue-500/30',
	};
</script>

<div
	role="alert"
	class="flex items-start gap-3 rounded-lg border bg-[var(--color-surface-secondary)] px-4 py-3 shadow-lg {borderColors[toast.type]}"
	style="max-width: 360px;"
	transition:fly={{ x: 100, duration: 250 }}
	onmouseenter={() => toastStore.pauseDismiss(toast.id)}
	onmouseleave={() => toastStore.resumeDismiss(toast.id)}
>
	<!-- Severity icon -->
	<div class="shrink-0 mt-0.5 {iconColors[toast.type]}">
		{#if toast.type === 'success'}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
		{:else if toast.type === 'error'}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
		{:else if toast.type === 'warning'}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
			</svg>
		{:else}
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
		{/if}
	</div>

	<!-- Content -->
	<div class="flex-1 min-w-0">
		<p class="text-sm text-[var(--color-text-primary)]">{toast.message}</p>
		{#if toast.action}
			<button
				onclick={toast.action.onclick}
				class="mt-1 text-xs font-medium text-[var(--color-accent)] hover:underline"
			>
				{toast.action.label}
			</button>
		{/if}
	</div>

	<!-- Close button -->
	<button
		onclick={() => onclose(toast.id)}
		class="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
		aria-label="Dismiss notification"
	>
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
		</svg>
	</button>
</div>
