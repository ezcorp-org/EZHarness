<script lang="ts">
	import { fetchCommandBody } from "$lib/api";
	import { store } from "$lib/stores.svelte";

	let {
		name,
		kind,
		status,
		onclick,
		stretch = false,
		tooltip,
	}: {
		name: string;
		kind: 'agent' | 'extension' | 'team' | 'file' | 'dir' | 'command';
		status?: 'pending' | 'running' | 'complete' | 'error';
		onclick?: () => void;
		stretch?: boolean;
		tooltip?: string;
	} = $props();

	let hovering = $state(false);
	let chipEl: HTMLSpanElement | undefined = $state();

	// Where the command-hover popover renders relative to the chip.
	// Default "above" matches current UX; flips to "below" when the chip
	// sits too close to the top of the viewport for the popover to fit.
	// Recomputed on every mouseenter so the right decision is made for
	// the chip's actual position (which can shift as the chat scrolls).
	//
	// The popover max height is 320px (pre) + header + padding; we use
	// 360px as the flip threshold to leave a small margin.
	let popoverPosition = $state<'above' | 'below'>('above');
	const POPOVER_FLIP_THRESHOLD_PX = 360;

	function computePopoverPosition() {
		if (!isCommand || !chipEl || typeof window === 'undefined') return;
		const rect = chipEl.getBoundingClientRect();
		const spaceAbove = rect.top;
		const spaceBelow = window.innerHeight - rect.bottom;
		// Default "above"; flip to "below" if there isn't enough room
		// above AND there's more room below. This keeps the popover
		// from being clipped when the chip is near the top of the page.
		if (spaceAbove < POPOVER_FLIP_THRESHOLD_PX && spaceBelow > spaceAbove) {
			popoverPosition = 'below';
		} else {
			popoverPosition = 'above';
		}
	}

	const statusColors: Record<string, string> = {
		pending: 'bg-gray-400',
		running: 'bg-yellow-400 animate-pulse',
		complete: 'bg-green-500',
		error: 'bg-red-500',
	};

	let isPath = $derived(kind === 'file' || kind === 'dir');
	let isCommand = $derived(kind === 'command');

	// File / dir chips show the basename in the pill; full path goes into the
	// tooltip. Dir chips append a trailing `/` so folders are visually distinct
	// from files at a glance.
	let displayName = $derived.by(() => {
		if (!isPath) return name;
		const base = name.lastIndexOf('/') >= 0 ? name.slice(name.lastIndexOf('/') + 1) : name;
		return kind === 'dir' ? `${base}/` : base;
	});

	// Sigil prefix matches the stored token syntax: `!` for agent/ext/team,
	// `@` for file/dir (path kinds), `/` for commands.
	let sigil = $derived(isPath ? '@' : isCommand ? '/' : '!');

	// For path chips (file/dir), always surface the full relative path on
	// hover even without an explicit tooltip prop.
	let effectiveTooltip = $derived(tooltip ?? (isPath ? name : undefined));

	// Command chips lazily resolve the prompt body on first hover so
	// readers can peek what the LLM actually received. Server-side
	// `applyCommandExpansion` substitutes the body at stream time; we
	// fetch it separately here just for display.
	let commandBody = $state<string | null>(null);
	let commandBodyLoading = $state(false);

	async function loadCommandBody() {
		if (!isCommand || commandBody !== null || commandBodyLoading) return;
		commandBodyLoading = true;
		try {
			// Project-scoped commands (`project:claude-commands`, etc.)
			// only resolve when we pass the active project. Treat the
			// sentinel `"global"` as "no project" so home + DB commands
			// still come through.
			const pid =
				store.activeProjectId && store.activeProjectId !== 'global'
					? store.activeProjectId
					: undefined;
			commandBody = await fetchCommandBody(name, pid);
		} finally {
			commandBodyLoading = false;
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="{effectiveTooltip || isCommand ? 'relative inline-block' : ''}" bind:this={chipEl}>
	<span
		class="relative inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium {kind === 'agent'
			? 'border-blue-500/30 bg-blue-500/20 text-blue-300'
			: kind === 'team'
				? 'border-indigo-500/30 bg-indigo-500/20 text-indigo-300'
				: kind === 'file'
					? 'border-green-500/30 bg-green-500/20 text-green-300'
					: kind === 'dir'
						? 'border-amber-500/30 bg-amber-500/20 text-amber-300'
						: kind === 'command'
							? 'border-pink-500/30 bg-pink-500/20 text-pink-300'
							: 'border-purple-500/30 bg-purple-500/20 text-purple-300'} {onclick ? 'cursor-pointer hover:brightness-125' : 'cursor-default'} {stretch ? 'w-full justify-center' : ''}"
		onclick={onclick}
		onkeydown={onclick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onclick?.(); } : undefined}
		onmouseenter={() => {
			if (effectiveTooltip || isCommand) hovering = true;
			if (isCommand) {
				computePopoverPosition();
				loadCommandBody();
			}
		}}
		onmouseleave={() => { hovering = false; }}
		role={onclick ? 'button' : undefined}
		tabindex={onclick ? 0 : undefined}
		data-mention-kind={kind}
		data-mention-name={name}
	>{sigil}{displayName}{#if status}<span class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full {statusColors[status] ?? ''}"></span>{/if}</span>
	{#if isCommand && hovering}
		<div
			class="absolute {popoverPosition === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'} left-0 z-30 w-max max-w-xl rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] shadow-lg"
			role="tooltip"
			data-command-popover={name}
			data-command-popover-position={popoverPosition}
		>
			<div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
				Prompt sent for /{name}
			</div>
			{#if commandBody !== null}
				<pre class="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-[var(--color-text-secondary)]">{commandBody}</pre>
			{:else if commandBodyLoading}
				<span class="text-[var(--color-text-muted)] italic">Loading prompt…</span>
			{:else}
				<span class="text-[var(--color-text-muted)] italic">Prompt body unavailable.</span>
			{/if}
		</div>
	{:else if effectiveTooltip && hovering}
		<span class="absolute bottom-full left-0 mb-1 z-20 max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap shadow-lg">{effectiveTooltip}</span>
	{/if}
</span>
