<script lang="ts">
	/**
	 * Phase 48 Wave 3 — slide-in Ez chat panel.
	 *
	 * The panel renders the user's single Ez conversation in a fixed
	 * 480px-wide drawer on the right. Composition lives here because
	 * the regular `ChatInput` mounts a much heavier loadout (mode/agent
	 * pickers, thinking-level selectors) — for Ez the surface is locked
	 * to a single mode, so we ship a smaller composer inline. ChatMessage
	 * isn't reused for the same reason: its props graph (tool calls,
	 * agent calls, content blocks, branch nav, ...) implies a chat
	 * runtime we don't have here. The panel renders messages with the
	 * same visual vocabulary (role-tinted bubbles, markdown body,
	 * inline tool cards) but as its own simpler composition.
	 *
	 * The "view full thread" link routes to `/conversations/<id>` so
	 * users can drop into the regular chat surface for search, fork,
	 * share, etc. — the panel is a *view* into the same conversation,
	 * not a fork of it.
	 *
	 * Streaming is handled by reloading on `run:complete` events from
	 * the same SSE bus the rest of the app uses; the panel listens
	 * specifically for events scoped to the Ez conversation. We do NOT
	 * try to reuse the global chat store because (a) it's
	 * project-scoped and (b) hooking into it would couple the panel
	 * to every chat-route assumption.
	 */
	import { onMount, onDestroy } from "svelte";
	import { page } from "$app/state";
	import { ezPanelState, closeEzPanel, consumePendingPrompt } from "$lib/ez/panel-store.svelte.js";
	import { getOrCreateEzConversation } from "$lib/ez/api.js";
	import { buildEzContextPayload } from "$lib/ez/context-serializer.js";
	import { readSnapshot } from "$lib/ez/registry.js";
	import { dispatch as dispatchClientTool } from "$lib/ez/client-tool-dispatcher.js";
	import { goto as appGoto } from "$app/navigation";
	import { fetchAllMessages, sendMessage, type Message } from "$lib/api.js";
	import EzToolResultCard, { type EzProposeResult } from "./EzToolResultCard.svelte";

	let {
		/** Bypass `getOrCreateEzConversation` — used by tests. */
		conversationIdOverride,
		/** Inject the goto used for client-side navigate_to. */
		goto = appGoto,
	}: {
		conversationIdOverride?: string;
		goto?: (path: string) => Promise<unknown> | unknown;
	} = $props();

	// Initial value is captured on mount; subsequent `conversationIdOverride`
	// changes are intentionally ignored — the panel reuses the resolved
	// id for the rest of the session.
	let conversationId = $state<string | null>(null);
	$effect(() => {
		if (!conversationId && conversationIdOverride) {
			conversationId = conversationIdOverride;
		}
	});
	let messages = $state<Message[]>([]);
	let input = $state("");
	let sending = $state(false);
	let error = $state<string | null>(null);
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	let scrollEl = $state<HTMLDivElement | null>(null);

	let panelOpen = $derived(ezPanelState.open);

	// Resolve the conversation id once on first open. Subsequent opens
	// reuse the cached id; the server enforces uniqueness so this is
	// idempotent regardless.
	async function ensureConversation() {
		if (conversationId) return;
		try {
			const conv = await getOrCreateEzConversation();
			conversationId = conv.conversationId;
		} catch (e) {
			error = `Could not load Ez conversation: ${(e as Error).message}`;
		}
	}

	async function refreshMessages() {
		if (!conversationId) return;
		try {
			messages = await fetchAllMessages(conversationId);
			// Defer scroll so the DOM updates first.
			queueMicrotask(() => {
				if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
			});
		} catch (e) {
			// Non-fatal — stale message list won't crash the panel.
			console.warn("Ez panel refresh failed", e);
		}
	}

	async function send() {
		if (!conversationId || !input.trim() || sending) return;
		const text = input.trim();
		const ezContext = buildEzContextPayload(page, readSnapshot());
		sending = true;
		error = null;
		try {
			// We pipe `ezContext` as a JSON string in a synthetic content
			// envelope. The Wave 4 server hook reads `ezContext` from the
			// JSON body; until then we still POST it so the wire format
			// is right when the server side lands.
			await sendMessage(conversationId, {
				content: text,
				// `ezContext` flows through `api.sendMessage` into the JSON
				// body. Server-side wiring lands in Wave 4; the endpoint
				// currently ignores unknown keys, which is forward-compatible.
				ezContext,
			});
			input = "";
			await refreshMessages();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			sending = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			void send();
		}
	}

	function close() { closeEzPanel(); }

	function viewFullThread() {
		if (conversationId) void goto(`/conversations/${conversationId}`);
	}

	// SSE → client-tool dispatch wiring. We listen to the global runtime
	// event stream the same way the rest of the app does (via /api/runtime-
	// events) but only for events tagged with our conversation id.
	let es: EventSource | null = null;
	function attachStream() {
		if (typeof window === "undefined" || !conversationId) return;
		try {
			es = new EventSource(`/api/runtime-events?conversationId=${encodeURIComponent(conversationId)}`);
			es.onmessage = (ev) => {
				try {
					const parsed = JSON.parse(ev.data) as { type: string; data?: { conversationId?: string } & Record<string, unknown> };
					if (parsed.type === "ez:client-tool" && parsed.data?.conversationId === conversationId) {
						void dispatchClientTool(
							{
								conversationId: parsed.data.conversationId,
								toolCallId: String(parsed.data.toolCallId ?? ""),
								toolName: String(parsed.data.toolName ?? ""),
								input: parsed.data.input,
							},
							{ goto },
						).catch(() => {});
					}
					if (parsed.type === "run:complete" && parsed.data?.conversationId === conversationId) {
						void refreshMessages();
					}
				} catch {
					// Heartbeat or malformed frame — ignore.
				}
			};
			es.onerror = () => { /* let the browser auto-reconnect */ };
		} catch {
			// SSE unavailable in this environment (e.g. tests) — silent.
		}
	}
	function detachStream() { es?.close(); es = null; }

	$effect(() => {
		if (!panelOpen) return;
		void (async () => {
			await ensureConversation();
			const prefill = consumePendingPrompt();
			if (prefill) input = prefill;
			await refreshMessages();
			// Focus the composer after the panel renders.
			queueMicrotask(() => composerEl?.focus());
			detachStream();
			attachStream();
		})();
	});

	// Detach the SSE stream when the panel closes so we don't keep an
	// open EventSource for a closed UI surface.
	$effect(() => {
		if (!panelOpen) detachStream();
	});

	onDestroy(() => detachStream());

	function tryParseProposeResult(content: string): EzProposeResult | null {
		// propose_* tools currently surface as either a JSON-encoded
		// content string or a tool-call card; until the server-side
		// rendering pipeline lands we look for `openUrl` in the content.
		try {
			const parsed = JSON.parse(content) as Partial<EzProposeResult> | undefined;
			if (parsed && typeof parsed.openUrl === "string") return parsed as EzProposeResult;
		} catch { /* not JSON */ }
		return null;
	}

	// Avoid SSR access to `window` during hydration tests.
	onMount(() => {
		if (panelOpen && !conversationId) void ensureConversation();
	});
</script>

{#if panelOpen}
	<div
		class="ez-panel"
		role="dialog"
		aria-modal="false"
		aria-label="Ez assistant"
		data-testid="ez-panel"
	>
		<header class="ez-panel__header">
			<div class="ez-panel__title">
				<span aria-hidden="true">🪄</span>
				<span>Ez</span>
			</div>
			<div class="ez-panel__header-actions">
				{#if conversationId}
					<button
						type="button"
						class="ez-panel__link"
						onclick={viewFullThread}
						data-testid="ez-view-full-thread"
					>
						Full thread
					</button>
				{/if}
				<button
					type="button"
					class="ez-panel__close"
					aria-label="Close Ez panel"
					data-testid="ez-panel-close"
					onclick={close}
				>
					×
				</button>
			</div>
		</header>

		<div class="ez-panel__messages" bind:this={scrollEl} data-testid="ez-panel-messages">
			{#if !conversationId}
				<div class="ez-panel__empty">Loading Ez conversation…</div>
			{:else if messages.length === 0}
				<div class="ez-panel__empty">
					Hi! I'm Ez. I can help you create projects, build agents, install
					extensions, summarize your conversations, fill forms, and navigate
					around. What do you need?
				</div>
			{:else}
				{#each messages as msg (msg.id)}
					{@const propose = msg.role === "tool" || msg.role === "assistant" ? tryParseProposeResult(msg.content) : null}
					<div class="ez-msg ez-msg--{msg.role}" data-testid="ez-message" data-role={msg.role}>
						{#if propose}
							<EzToolResultCard result={propose} {goto} />
						{:else}
							<div class="ez-msg__body">{msg.content}</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>

		{#if error}
			<div class="ez-panel__error" role="alert">{error}</div>
		{/if}

		<div class="ez-panel__composer">
			<textarea
				bind:this={composerEl}
				bind:value={input}
				rows="2"
				placeholder="Ask Ez to do something for you…"
				aria-label="Message Ez"
				data-testid="ez-panel-input"
				disabled={!conversationId}
				onkeydown={handleKeydown}
			></textarea>
			<button
				type="button"
				class="ez-panel__send"
				disabled={!conversationId || !input.trim() || sending}
				data-testid="ez-panel-send"
				onclick={() => void send()}
			>
				{sending ? "Sending…" : "Send"}
			</button>
		</div>
	</div>
{/if}

<style>
	.ez-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(480px, 100vw);
		z-index: 50;
		display: flex;
		flex-direction: column;
		background: var(--color-surface);
		border-left: 1px solid var(--color-border);
		box-shadow: -12px 0 32px rgba(0, 0, 0, 0.18);
	}
	.ez-panel__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
	}
	.ez-panel__title {
		display: inline-flex;
		gap: 0.5rem;
		font-weight: 700;
		color: var(--color-text-primary);
	}
	.ez-panel__header-actions { display: inline-flex; gap: 0.5rem; align-items: center; }
	.ez-panel__link {
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
		padding: 0.25rem 0.55rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}
	.ez-panel__link:hover { color: var(--color-text-primary); }
	.ez-panel__close {
		font-size: 1.25rem;
		line-height: 1;
		background: transparent;
		border: none;
		color: var(--color-text-muted);
		cursor: pointer;
		padding: 0.15rem 0.5rem;
		border-radius: 0.35rem;
	}
	.ez-panel__close:hover { color: var(--color-text-primary); background: var(--color-surface-tertiary); }
	.ez-panel__messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.ez-panel__empty {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		padding: 0.5rem 0;
	}
	.ez-msg {
		max-width: 100%;
		font-size: 0.875rem;
		line-height: 1.45;
	}
	.ez-msg__body {
		white-space: pre-wrap;
		word-break: break-word;
		padding: 0.55rem 0.75rem;
		border-radius: 0.5rem;
		background: var(--color-surface-secondary);
		color: var(--color-text-primary);
	}
	.ez-msg--user .ez-msg__body {
		background: var(--color-accent, #4c8cff);
		color: white;
		align-self: flex-end;
	}
	.ez-msg--user { align-self: flex-end; max-width: 80%; }
	.ez-panel__error {
		color: #d44a4a;
		background: rgba(212, 74, 74, 0.08);
		border-top: 1px solid rgba(212, 74, 74, 0.2);
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
	}
	.ez-panel__composer {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem;
		border-top: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		align-items: flex-end;
	}
	.ez-panel__composer textarea {
		flex: 1;
		resize: none;
		font-family: inherit;
		font-size: 0.875rem;
		padding: 0.5rem 0.65rem;
		border-radius: 0.4rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text-primary);
		outline: none;
	}
	.ez-panel__composer textarea:focus { border-color: var(--color-accent, #4c8cff); }
	.ez-panel__composer textarea:disabled { opacity: 0.6; }
	.ez-panel__send {
		padding: 0.55rem 0.95rem;
		border-radius: 0.4rem;
		border: none;
		background: var(--color-accent, #4c8cff);
		color: white;
		font-weight: 600;
		cursor: pointer;
		font-size: 0.875rem;
	}
	.ez-panel__send:disabled { filter: grayscale(0.5); cursor: not-allowed; }
</style>
