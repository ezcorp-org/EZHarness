<script lang="ts">
	import Brain from 'lucide-svelte/icons/brain';
	import Plus from 'lucide-svelte/icons/plus';
	import Minus from 'lucide-svelte/icons/minus';
	import Check from 'lucide-svelte/icons/check';
	import Strikethrough from 'lucide-svelte/icons/strikethrough';
	import Loader2 from 'lucide-svelte/icons/loader-2';
	import { copyToClipboard } from "$lib/clipboard.js";
	import Tooltip from "./Tooltip.svelte";
	import LucideIcon from "./LucideIcon.svelte";
	import type { ExtensionAction } from "$lib/chat/extension-toolbar-action.js";

	const btnClass = "p-1.5 rounded-full hover:bg-[var(--color-surface-tertiary)] hover:outline hover:outline-1 hover:outline-[var(--color-text-muted)]/30 transition-colors min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center";

	let {
		role,
		isError = false,
		content,
		renderedHtml,
		oncopy,
		onedit,
		onregenerate,
		onbranch,
		onretry,
		onsavememory,
		onremovememory,
		savedAsMemory = false,
		onedittext,
		onexclude,
		excluded = false,
		extensionActions = [],
		variant = 'hover',
		testid,
	}: {
		role: 'user' | 'assistant';
		isError?: boolean;
		content: string;
		renderedHtml?: string;
		oncopy?: () => void;
		onedit?: () => void;
		onregenerate?: () => void;
		onbranch?: () => void;
		onretry?: () => void;
		onsavememory?: () => void;
		onremovememory?: () => void;
		savedAsMemory?: boolean;
		/** Content-only edit of an assistant turn (no regen). Surfaced as
		 *  "Edit text" for assistant rows — primarily useful on seeded turns
		 *  in a cloned chat. */
		onedittext?: () => void;
		/** Toggle this message's `excluded` flag. When excluded, load-history
		 *  drops it from the array passed to the LLM on subsequent turns,
		 *  while the row stays in the transcript struck-through. */
		onexclude?: () => void;
		excluded?: boolean;
		/** Extension-contributed toolbar buttons. Render between the
		 *  exclude affordance and the save-memory button so the
		 *  established left-to-right ordering (copy → edit → regen →
		 *  branch → exclude → [extensions] → save-memory) holds. The
		 *  host fetches these from
		 *  `/api/conversations/{id}/extension-toolbar` and binds each
		 *  entry's `onclick` to fire the extension event. */
		extensionActions?: ExtensionAction[];
		/** `'hover'` — anchored to a message row, fades in on group hover (default).
		 *  `'inline'` — flows in normal layout, always visible. Used by the
		 *  multi-select bulk action bar so the same icon set drives bulk ops. */
		variant?: 'hover' | 'inline';
		testid?: string;
	} = $props();

	let copyState: 'idle' | 'copied' = $state('idle');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let justSaved = $state(false);
	let justSavedTimer: ReturnType<typeof setTimeout> | undefined;
	let hoveringMemoryBtn = $state(false);

	// In-flight tracking for extension actions. Keyed by
	// `${extName}:${id}` so two different actions can run concurrently
	// without their spinners colliding. The button swaps to a Loader2
	// icon and is disabled for the duration of the click handler — gives
	// the user immediate synchronous feedback that the click registered,
	// which they don't get from the eventual chat-side rendering of the
	// new turn (that arrives over SSE after the subprocess responds).
	let inflightActions: Record<string, boolean> = $state({});
	// Force the toolbar to stay visible while any extension action is in
	// flight. Otherwise the user clicks the spinner-replaced icon, the
	// mouse moves off the row, the `group-hover:opacity-100` collapses,
	// and the spinner is invisible — the user thinks nothing's happening.
	let anyInflight = $derived(Object.values(inflightActions).some(Boolean));

	async function runExtensionAction(action: ExtensionAction): Promise<void> {
		const key = `${action.extName}:${action.id}`;
		if (inflightActions[key]) return; // re-click while in flight = no-op
		inflightActions[key] = true;
		try {
			await action.onclick();
		} finally {
			inflightActions[key] = false;
		}
	}

	async function handleCopy(e: MouseEvent) {
		try {
			if (e.shiftKey && renderedHtml && navigator.clipboard?.write) {
				// Rich text copy: both plain and HTML
				await navigator.clipboard.write([
					new ClipboardItem({
						'text/plain': new Blob([content], { type: 'text/plain' }),
						'text/html': new Blob([renderedHtml], { type: 'text/html' }),
					}),
				]);
			} else {
				await copyToClipboard(content);
			}
			copyState = 'copied';
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copyState = 'idle'), 1500);
			oncopy?.();
		} catch {
			// Fallback
			const ok = await copyToClipboard(content);
			if (ok) {
				copyState = 'copied';
				clearTimeout(copyTimer);
				copyTimer = setTimeout(() => (copyState = 'idle'), 1500);
				oncopy?.();
			} else {
				// Clipboard not available
			}
		}
	}
</script>

<div
	data-testid={testid}
	class={variant === 'inline'
		? 'flex items-center gap-0.5 rounded-full bg-[var(--color-surface-secondary)] border border-[var(--color-border)] shadow-lg px-1 py-0.5'
		: `absolute -bottom-3 right-2 z-10 flex items-center gap-0.5 rounded-full bg-[var(--color-surface-secondary)] border border-[var(--color-border)] shadow-lg px-1 py-0.5 transition-opacity duration-150 ${anyInflight ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
>
	{#if isError && onretry}
		<Tooltip text="Retry this failed message">
			<button onclick={onretry} class={btnClass} aria-label="Retry">
				<svg class="h-3.5 w-3.5 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path d="M1 4v6h6" /><path d="M23 20v-6h-6" />
					<path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
				</svg>
			</button>
		</Tooltip>
	{:else}
		<Tooltip text={copyState === 'copied' ? 'Copied!' : 'Copy message (Shift+click for rich text)'}>
			<button onclick={handleCopy} class={btnClass} aria-label={copyState === 'copied' ? 'Copied!' : 'Copy message'}>
				{#if copyState === 'copied'}
					<svg class="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
				{:else}
					<svg class="h-3.5 w-3.5 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
					</svg>
				{/if}
			</button>
		</Tooltip>

		{#if role === 'user' && onedit}
			<Tooltip text="Edit and regenerate response">
				<button onclick={onedit} class={btnClass} aria-label="Edit message">
					<svg class="h-3.5 w-3.5 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
						<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
					</svg>
				</button>
			</Tooltip>
		{/if}

		{#if role === 'assistant' && onregenerate}
			<Tooltip text="Regenerate this response">
				<button onclick={onregenerate} class={btnClass} aria-label="Regenerate response">
					<svg class="h-3.5 w-3.5 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M1 4v6h6" /><path d="M23 20v-6h-6" />
						<path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
					</svg>
				</button>
			</Tooltip>
		{/if}

		{#if role === 'assistant' && onedittext}
			<Tooltip text="Edit saved text (no regenerate)">
				<button onclick={onedittext} class={btnClass} aria-label="Edit text" data-testid="edit-text-btn">
					<svg class="h-3.5 w-3.5 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
						<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
					</svg>
				</button>
			</Tooltip>
		{/if}

		{#if onbranch}
			<Tooltip text="Branch conversation from here">
				<button onclick={onbranch} class={btnClass} aria-label="Branch from here">
					<svg class="h-3.5 w-3.5 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<line x1="6" y1="3" x2="6" y2="15" />
						<circle cx="18" cy="6" r="3" />
						<circle cx="6" cy="18" r="3" />
						<path d="M18 9a9 9 0 0 1-9 9" />
					</svg>
				</button>
			</Tooltip>
		{/if}

		{#if onexclude}
			<Tooltip text={excluded ? 'Include in LLM context' : 'Exclude from LLM context'}>
				<button
					onclick={onexclude}
					class={btnClass}
					aria-label={excluded ? 'Include in LLM context' : 'Exclude from LLM context'}
					aria-pressed={excluded}
					data-testid="exclude-context-btn"
				>
					<Strikethrough
						class={`h-3.5 w-3.5 ${excluded ? 'text-amber-400' : 'text-[var(--color-text-muted)]'}`}
						strokeWidth={2}
					/>
				</button>
			</Tooltip>
		{/if}

		{#each extensionActions as action (action.extName + ':' + action.id)}
			{@const key = action.extName + ':' + action.id}
			{@const busy = inflightActions[key] === true}
			<Tooltip text={busy ? `${action.tooltip} (working…)` : action.tooltip}>
				<button
					onclick={() => runExtensionAction(action)}
					disabled={busy}
					class={`${btnClass} text-[var(--color-text-primary)]${busy ? ' opacity-70 cursor-wait' : ''}`}
					aria-label={action.tooltip}
					aria-busy={busy}
					data-testid={`ext-action-${action.extName}-${action.id}`}
					data-extension-action={key}
				>
					<!--
					  Color is set on the BUTTON (not the icon) so it
					  cascades to the SVG via lucide's default
					  `stroke="currentColor"`. We can't rely on
					  class-prop forwarding through LucideIcon's dynamic
					  `<Resolved>` for color: lucide-svelte's icon
					  components are still in Svelte 4 legacy mode and
					  their `$$props.class` merge isn't reliably hit
					  when invoked as a dynamic component value in
					  Svelte 5. Setting `color` on the button instead
					  inherits down regardless.

					  `size={14}` is forwarded explicitly (NOT a CSS
					  size class) because lucide legacy mode hard-codes
					  `width={size}` / `height={size}` AS SVG attributes
					  (default 24); Tailwind h-N/w-N only fix this for
					  static-imported icons whose class lands on the
					  same element. Dynamic resolution requires the
					  `size` prop to reach Icon.svelte directly.
					-->
					{#if busy}
						<Loader2 size={14} strokeWidth={2.25} class="animate-spin" />
					{:else}
						<LucideIcon
							name={action.icon}
							size={14}
							strokeWidth={2.25}
						/>
					{/if}
				</button>
			</Tooltip>
		{/each}

		{#if onsavememory}
			{@const isSaved = savedAsMemory && !justSaved}
			{@const showRemove = isSaved && hoveringMemoryBtn && onremovememory}
			<Tooltip text={justSaved ? 'Saved to memory!' : isSaved ? 'Remove from memory' : 'Save to memory'}>
				<button
					data-testid="save-memory-btn"
					onclick={() => {
						if (showRemove) {
							onremovememory!();
							hoveringMemoryBtn = false;
						} else if (!isSaved) {
							onsavememory!();
							justSaved = true;
							clearTimeout(justSavedTimer);
							justSavedTimer = setTimeout(() => (justSaved = false), 1500);
						}
					}}
					onmouseenter={() => (hoveringMemoryBtn = true)}
					onmouseleave={() => (hoveringMemoryBtn = false)}
					class={btnClass}
					aria-label={justSaved ? 'Saved to memory!' : showRemove ? 'Remove from memory' : isSaved ? 'Saved to memory' : 'Save to memory'}
				>
					{#if justSaved}
						<Check class="h-3.5 w-3.5 text-green-500" strokeWidth={2} />
					{:else if showRemove}
						<span class="relative inline-flex">
							<Brain class="h-3.5 w-3.5 text-red-400" strokeWidth={1.5} />
							<span class="absolute -bottom-1 -right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-[var(--color-surface-secondary)]">
								<Minus class="h-2 w-2 text-red-400" strokeWidth={3} />
							</span>
						</span>
					{:else if isSaved}
						<span class="relative inline-flex">
							<Brain class="h-3.5 w-3.5 text-green-500" strokeWidth={1.5} />
							<span class="absolute -bottom-1 -right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-[var(--color-surface-secondary)]">
								<Check class="h-2 w-2 text-green-500" strokeWidth={3} />
							</span>
						</span>
					{:else}
						<span class="relative inline-flex">
							<Brain class="h-3.5 w-3.5 text-[var(--color-text-muted)]" strokeWidth={1.5} />
							<span class="absolute -bottom-1 -right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-[var(--color-surface-secondary)]">
								<Plus class="h-2 w-2 text-[var(--color-text-muted)]" strokeWidth={3} />
							</span>
						</span>
					{/if}
				</button>
			</Tooltip>
		{/if}
	{/if}
</div>
