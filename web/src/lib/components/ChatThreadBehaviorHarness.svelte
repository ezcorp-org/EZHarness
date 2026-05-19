<script lang="ts">
	/**
	 * PHASE 4 re-point — the Phase-0 behaviour pin now exercises the REAL
	 * `<ChatThread>`.
	 *
	 * Phase 0 created this harness driving the page's shared factories
	 * directly (the DRY proof scaffold). Phase 4 extracted `<ChatThread>`;
	 * this harness is re-pointed to MOUNT the real component, seed it
	 * synchronously (`seedMessages`/`seedLeafId`, the production embed
	 * seam), bind its live reactive mirror (`live`), and project that
	 * mirror onto the SAME testid contract the Phase-0 suite asserts.
	 * `ChatThread.behavior.component.test.ts` keeps every `expect()`
	 * byte-identical — only this wiring file changed. That unchanged-green
	 * state is the DRY proof: same 8 behaviours, served by the extracted
	 * component instead of an inlined copy.
	 */
	import { tick } from "svelte";
	import ChatThread, {
		type ChatThreadChrome,
	} from "./ChatThread.svelte";
	import { store } from "$lib/stores.svelte.js";
	import type { Message } from "$lib/api.js";

	interface Props {
		conversationId?: string;
		initialMessages: Message[];
		initialLeafId: string | null;
		onLoadMessages?: () => void;
		onInvalidate?: (key: string) => void;
		onHydrate?: () => void;
	}

	let {
		conversationId = "conv-1",
		initialMessages,
		initialLeafId,
		onLoadMessages,
		onInvalidate,
		onHydrate,
	}: Props = $props();

	// Register the cooldown-bust spies so the fetch-policy mock forwards
	// invalidate / loadMessages / hydrate to them (the extension-turn
	// pin asserts these). Wiring only — the real ChatThread runs the
	// real handleExtensionTurnSaved.
	const seedFn = (
		globalThis as unknown as {
			__chatThreadSeed?: (
				t: Message[],
				spies?: {
					onInvalidate?: (k: string) => void;
					onLoadMessages?: () => void;
					onHydrate?: () => void;
				},
			) => void;
		}
	).__chatThreadSeed;
	if (seedFn)
		seedFn(initialMessages, { onInvalidate, onLoadMessages, onHydrate });

	let thread: ChatThread | undefined = $state();
	// Two-way live mirror bound from the real <ChatThread>. Synchronous:
	// ChatThread's $effect writes it on every derived change, and the
	// synchronous `seedMessages` seed means it's populated by first paint.
	let live = $state<ChatThreadChrome | undefined>();

	let messages = $derived(live?.messages ?? []);
	let allMessages = $derived(live?.allMessages ?? []);
	let activeLeafId = $derived(live?.activeLeafId ?? null);
	let errorText = $derived(live?.error ?? "");
	// Track the runId the harness itself bound via startRunStream so the
	// streamed-text mirror reads the runId-keyed store with ZERO
	// child→parent effect lag (the pin uses a single `await
	// Promise.resolve()`; depending on `live.activeRunId` would add a
	// flush hop). Same store source ChatThread's own $derived reads.
	let boundRunId = $state<string | null>(null);
	let streamingText = $derived(
		boundRunId ? (store.streamingMessages[boundRunId] ?? "") : "",
	);
	let leafQueryEcho = $derived(
		activeLeafId ? `?leaf=${activeLeafId}` : "",
	);

	function sortedSiblings(msg: Message) {
		const key = msg.parentMessageId ?? "__root__";
		return allMessages
			.filter((m) => (m.parentMessageId ?? "__root__") === key)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	function siblingInfo(msg: Message): { count: number; index: number } {
		const sibs = sortedSiblings(msg);
		return {
			count: sibs.length,
			index: sibs.findIndex((s) => s.id === msg.id),
		};
	}
	function navPrev(msg: Message) {
		const sibs = sortedSiblings(msg);
		const idx = sibs.findIndex((s) => s.id === msg.id);
		if (idx > 0)
			(
				thread as unknown as {
					navigateBranch: (id: string) => void;
				}
			).navigateBranch(sibs[idx - 1]!.id);
	}
	function navNext(msg: Message) {
		const sibs = sortedSiblings(msg);
		const idx = sibs.findIndex((s) => s.id === msg.id);
		if (idx >= 0 && idx < sibs.length - 1)
			(
				thread as unknown as {
					navigateBranch: (id: string) => void;
				}
			).navigateBranch(sibs[idx + 1]!.id);
	}

	let selectedIds = $state(new Set<string>());
	function toggleSelect() {
		(
			thread as unknown as { toggleSelectMode: () => void }
		).toggleSelectMode();
	}
	function toggleRow(id: string) {
		(
			thread as unknown as {
				toggleSelectedMessage: (id: string) => void;
			}
		).toggleSelectedMessage(id);
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	export function fireExtensionTurn(messageId: string): boolean {
		return (
			thread as unknown as {
				fireExtensionTurn: (id: string) => boolean;
			}
		).fireExtensionTurn(messageId);
	}
	export async function doRegenerate(msg: Message) {
		await (
			thread as unknown as {
				doRegenerate: (m: Message) => Promise<void>;
			}
		).doRegenerate(msg);
		await tick();
	}
	export async function doRetry(msg: Message) {
		await (
			thread as unknown as { doRetry: (m: Message) => Promise<void> }
		).doRetry(msg);
		await tick();
	}
	export function startRunStream(runId: string) {
		boundRunId = runId;
		(
			thread as unknown as { startRunStream: (id: string) => void }
		).startRunStream(runId);
	}
</script>

<div style="display:none">
	<ChatThread
		bind:this={thread}
		bind:live
		{conversationId}
		projectId="proj-1"
		variant="page"
		seedMessages={initialMessages}
		seedLeafId={initialLeafId}
		convListRefresh={() => {}}
	/>
</div>

<div data-testid="leaf-query">{leafQueryEcho}</div>
<div data-testid="path-count">{messages.length}</div>
<div data-testid="streaming-text">{streamingText}</div>
<div data-testid="error">{errorText}</div>
<div data-testid="select-count">{selectedIds.size}</div>

<button data-testid="toggle-select" onclick={toggleSelect}>select</button>

<ul>
	{#each messages as msg (msg.id)}
		{@const info = siblingInfo(msg)}
		<li data-testid="msg-{msg.id}">
			<span data-testid="content-{msg.id}">{msg.content}</span>
			{#if info.count > 1}
				<span data-testid="branch-nav-{msg.id}"
					>{info.index + 1}/{info.count}</span
				>
				<button
					data-testid="prev-{msg.id}"
					aria-label="Previous version"
					onclick={() => navPrev(msg)}>‹</button
				>
				<button
					data-testid="next-{msg.id}"
					aria-label="Next version"
					onclick={() => navNext(msg)}>›</button
				>
			{/if}
			<span
				role="checkbox"
				tabindex="0"
				data-testid="rowsel-{msg.id}"
				aria-checked={selectedIds.has(msg.id)}
				onclick={() => toggleRow(msg.id)}
				onkeydown={() => {}}>·</span
			>
		</li>
	{/each}
</ul>
