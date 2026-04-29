<script lang="ts">
	/**
	 * Phase 48 Wave 3 — slide-in Ez chat panel.
	 *
	 * The panel renders the user's single Ez conversation in a fixed
	 * 480px-wide drawer on the right. It reuses the same building blocks
	 * the regular chat page uses:
	 *
	 *   - `ChatInput.svelte` for composition — the literal same component
	 *     the chat page imports. We pass `lockedMode={ modeSlug: 'ez',
	 *     label: 'Ez' }` so the Mode picker is rendered disabled (pinned
	 *     to "Ez" — the conversation's `modeId` is fixed server-side),
	 *     while the Model picker and Thinking-level picker stay fully
	 *     interactive: the panel manages those locally and persists the
	 *     user's choice to localStorage so it survives reloads. The
	 *     attachments paperclip remains hidden in locked mode. This
	 *     guarantees the panel composer's mention popover, chip
	 *     rendering, and Enter/Shift+Enter behavior stay in lock-step
	 *     with the chat page — there's no second textarea variant to
	 *     keep in sync.
	 *
	 *   - `ChatMessage.svelte` for rendering. Every prop on ChatMessage
	 *     beyond `message` is optional with a sensible default, so the
	 *     panel passes only what makes sense in Ez context (streaming
	 *     text + status from the global store, conversationId, an
	 *     `onsendmessage` for tool-call follow-ups). Branch nav, retry,
	 *     edit, save-memory, regenerate, etc. are intentionally not
	 *     wired — the panel is a streamlined surface, full control lives
	 *     on the regular chat page (linked via "Full thread").
	 *
	 *   - The same SSE consumption pattern as the chat page: when
	 *     `api.sendMessage` returns a runId, we register it with
	 *     `startStreaming(runId, conversationId)`. The global SSE
	 *     subscriber (initStores → createWSClient) routes
	 *     `run:token` / `run:status` / `run:complete` events into
	 *     `store.streamingMessages[runId]`, which we read via the
	 *     `currentStreamingText` derived. `run:turn_saved` and
	 *     `run:complete` events fire the same `ez:turn_saved` /
	 *     `run:complete` window-event signals the chat page listens to,
	 *     and we use them to swap streaming placeholders for persisted
	 *     messages and refresh the message list.
	 *
	 *   - Client-side tool dispatch (`fill_form` / `navigate_to`) flows
	 *     through the same global SSE — `stores.svelte.ts` re-dispatches
	 *     `ez:client-tool` bus events as window CustomEvents, and we
	 *     listen for them here. The previous implementation maintained a
	 *     separate `EventSource('/api/runtime-events?conversationId=…')`;
	 *     keeping a second SSE alive for the same data was both wasteful
	 *     and a divergence from how the chat page consumes runtime events.
	 *
	 * The "Full thread" link routes to `/conversations/<id>` so users can
	 * drop into the regular chat surface for search, fork, share, etc. —
	 * the panel is a *view* into the same conversation, not a fork of it.
	 */
	import { onMount, onDestroy } from "svelte";
	import { page } from "$app/state";
	import { ezPanelState, closeEzPanel, consumePendingPrompt } from "$lib/ez/panel-store.svelte.js";
	import { getOrCreateEzConversation, clearEzConversation } from "$lib/ez/api.js";
	import Trash2 from "lucide-svelte/icons/trash-2";
	import { buildEzContextPayload } from "$lib/ez/context-serializer.js";
	import { readSnapshot } from "$lib/ez/registry.js";
	import { dispatch as dispatchClientTool } from "$lib/ez/client-tool-dispatcher.js";
	import { goto as appGoto } from "$app/navigation";
	import { fetchAllMessages, sendMessage, type Message } from "$lib/api.js";
	import {
		store,
		startStreaming,
		stopStreaming,
	} from "$lib/stores.svelte.js";
	import ChatInput from "$lib/components/ChatInput.svelte";
	import ChatMessage from "$lib/components/ChatMessage.svelte";

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
	let activeRunId = $state<string | null>(null);
	let pendingPrefill = $state<string>("");
	let error = $state<string | null>(null);
	let scrollEl = $state<HTMLDivElement | null>(null);
	// "Clear conversation" in-flight flag. Disables the button and
	// short-circuits a double-click while the DELETE round-trips.
	let clearing = $state<boolean>(false);

	// ── Model + thinking-level state ─────────────────────────────────
	//
	// Mirrors the chat page (`+page.svelte`): `selectedModel` drives the
	// `<ModelSelector>` displayed in the locked toolbar, `thinkingLevel`
	// drives `<ThinkingLevelSelector>` (when the model supports
	// reasoning). The panel persists both to its own localStorage keys
	// (separate from the chat page's `last-model` / `ezcorp-thinking-
	// level` so opening Ez never overwrites the user's preferred chat
	// configuration) and ships them inline with each `sendMessage` call
	// so the runtime knows which provider/model to route through.
	const LS_MODEL = "ez-panel:selected-model";
	const LS_THINKING = "ez-panel:thinking-level";

	function loadStoredModel(): { provider: string; model: string } | null {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(LS_MODEL);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
			if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
				return { provider: parsed.provider, model: parsed.model };
			}
		} catch {
			// Malformed JSON — drop the stale value rather than crash.
		}
		return null;
	}

	function loadStoredThinking(): string {
		if (typeof localStorage === "undefined") return "medium";
		return localStorage.getItem(LS_THINKING) ?? "medium";
	}

	let selectedModel = $state<{ provider: string; model: string } | null>(loadStoredModel());
	let thinkingLevel = $state<string>(loadStoredThinking());
	let modelSupportsReasoning = $state(false);

	function handleModelChange(provider: string, model: string) {
		selectedModel = { provider, model };
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(LS_MODEL, JSON.stringify({ provider, model }));
		}
	}

	// Auto-select fires when the picker resolves a default the first time.
	// Only persist if we don't already have a stored pick — same guard the
	// chat page uses, so a fast `/api/models` response can't overwrite the
	// user's saved choice during the open animation.
	function handleModelAutoSelect(provider: string, model: string) {
		if (selectedModel) return;
		selectedModel = { provider, model };
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(LS_MODEL, JSON.stringify({ provider, model }));
		}
	}

	function handleThinkingLevelChange(level: string) {
		thinkingLevel = level;
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(LS_THINKING, level);
		}
	}

	function handleReasoningChange(reasoning: boolean) {
		modelSupportsReasoning = reasoning;
	}

	let panelOpen = $derived(ezPanelState.open);

	// Read streaming text/status the same way the chat page does — through
	// the global store. `startStreaming` populates these slots; the SSE
	// subscriber appends tokens; `stopStreaming` (fired on `run:complete`)
	// clears them. The optimistic placeholder assistant message in
	// `messages` keys off `runId`, so we can pick out the right entry to
	// fill in.
	let currentStreamingText = $derived(
		activeRunId ? store.streamingMessages[activeRunId] : undefined,
	);
	let currentStreamingStatus = $derived(
		activeRunId ? store.streamingStatus[activeRunId] : undefined,
	);
	let isStreaming = $derived(
		activeRunId !== null &&
			(store.streamingMessages[activeRunId] !== undefined ||
				store.streamingStatus[activeRunId] !== undefined),
	);

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

	/**
	 * Build a synthetic Message for the optimistic UI. Mirrors the
	 * `makeOptimisticMessage` helper on the chat page — we keep the
	 * defaults aligned so ChatMessage renders both consistently.
	 */
	function makeOptimisticMessage(
		overrides: Partial<Message> & Pick<Message, "conversationId">,
	): Message {
		return {
			id: "",
			role: "user",
			content: "",
			thinkingContent: null,
			model: null,
			provider: null,
			usage: null,
			runId: null,
			parentMessageId: null,
			excluded: false,
			createdAt: new Date().toISOString(),
			...overrides,
		};
	}

	/**
	 * `ChatInput` calls this with the trimmed content (and optional
	 * attachments — unused on the Ez surface because attachments are
	 * suppressed by `lockedMode`). The composer handles its own
	 * value/height reset on submit; we surface errors by re-throwing so
	 * the component can roll back UI state if needed.
	 */
	async function send(content: string): Promise<void> {
		if (!conversationId) throw new Error("Ez conversation not ready");
		// Defense-in-depth: ChatInput's submit gate blocks the click while
		// `selectedModel` is null (waiting for ModelSelector's autoselect to
		// fire), but a programmatic caller — Enter handler, future test
		// harness, retry path — could still invoke send() directly. Refuse
		// rather than ship an empty provider/model on the wire (the server
		// would silently fall back to default-tier resolution because
		// Ez conv rows store model=null/provider=null).
		if (!selectedModel) throw new Error("No model selected");
		const ezContext = buildEzContextPayload(page, readSnapshot());
		error = null;

		// Optimistic user message — same pattern as the chat page.
		const convIdNow = conversationId;
		const optimisticUserMsg = makeOptimisticMessage({
			id: `temp-${Date.now()}`,
			conversationId: convIdNow,
			role: "user",
			content,
		});
		messages = [...messages, optimisticUserMsg];

		try {
			const result = await sendMessage(convIdNow, {
				content,
				// Ship the user's chosen model + thinking level inline so
				// the runtime routes the run through the right provider.
				// Mirrors the chat page's `handleSend` payload shape. The
				// `if (!selectedModel)` guard above ensures these are
				// always concrete strings — never omitted from the wire.
				provider: selectedModel.provider,
				model: selectedModel.model,
				thinkingLevel,
				// `ezContext` flows through `api.sendMessage` into the JSON
				// body; the server reads it from the request payload.
				ezContext,
			});

			// Replace the optimistic user message with the real persisted one.
			messages = messages.map((m) =>
				m.id === optimisticUserMsg.id ? result.userMessage : m,
			);

			// Register the runId with the global streaming store so SSE
			// `run:token` / `run:status` events accumulate into
			// `store.streamingMessages[runId]`. Same call the chat page
			// makes — same downstream consumers.
			const started = startStreaming(result.runId, convIdNow);
			if (!started) {
				// Race: run completed/errored before startStreaming
				// registered. Refetch messages to pick up the persisted
				// turn(s).
				activeRunId = null;
				await refreshMessages();
				return;
			}
			activeRunId = result.runId;

			// Optimistic assistant placeholder — keyed by runId so the
			// `ez:turn_saved` swap below can find it.
			const assistantPlaceholder = makeOptimisticMessage({
				id: `streaming-${result.runId}`,
				conversationId: convIdNow,
				role: "assistant",
				runId: result.runId,
				parentMessageId: result.userMessage.id,
			});
			messages = [...messages, assistantPlaceholder];
			queueMicrotask(() => {
				if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
			});
		} catch (e) {
			// Roll back the optimistic user message and surface the error.
			messages = messages.filter((m) => m.id !== optimisticUserMsg.id);
			error = (e as Error).message;
			throw e;
		}
	}

	/**
	 * "Clear conversation / start fresh" — wipes every message on the
	 * server side and resets the panel's local view to an empty state.
	 * The conversation id stays the same (schema enforces one Ez convo
	 * per user), so the panel's SSE subscription, ezContext, and locked
	 * mode all keep working unchanged. The composer's typed-but-unsent
	 * prompt is left as-is so the user doesn't lose their draft.
	 *
	 * Uses the codebase's existing destructive-action confirm pattern
	 * (e.g. project settings, custom-mode delete) — `window.confirm()`
	 * with an actionable, single-sentence prompt.
	 */
	async function handleClear(): Promise<void> {
		if (clearing) return;
		if (!conversationId) return;
		if (typeof window === "undefined" || !window.confirm("Clear this Ez conversation? All messages will be deleted.")) return;

		clearing = true;
		error = null;
		try {
			// Stop any in-flight stream BEFORE the DB wipe so the SSE
			// consumer doesn't try to swap a streaming placeholder for a
			// row that no longer exists. `stopStreaming` clears the per-
			// run slots in the global store; the next `run:complete`
			// signal becomes a no-op.
			if (activeRunId) {
				stopStreaming(activeRunId);
				activeRunId = null;
			}
			await clearEzConversation();
			// Wipe local view — show the same empty-state the panel
			// renders on first open (the `messages.length === 0` branch
			// in the template).
			messages = [];
		} catch (e) {
			error = `Could not clear conversation: ${(e as Error).message}`;
		} finally {
			clearing = false;
		}
	}

	function close() {
		closeEzPanel();
	}

	function viewFullThread() {
		if (conversationId) void goto(`/conversations/${conversationId}`);
	}

	// ── Window-event listeners (replace bespoke EventSource) ─────────
	//
	// `stores.svelte.ts` dispatches `ez:turn_saved` and `ez:client-tool`
	// as window CustomEvents — we ride those instead of opening a second
	// SSE connection. `run:complete` clean-up runs through the same path
	// as the chat page (stopStreaming clears the per-run slots in the
	// global store).

	function handleTurnSaved(e: Event) {
		const detail = (e as CustomEvent).detail as {
			runId: string;
			conversationId: string;
			messageId: string;
			parentMessageId: string | null;
			content: string;
		};
		if (detail.conversationId !== conversationId) return;
		if (!activeRunId || detail.runId !== activeRunId) return;

		// Replace the streaming placeholder with the persisted assistant
		// turn, then queue a fresh placeholder for the next turn (mirrors
		// the chat page; tool calls and follow-ups sit between turns).
		const realMsg = makeOptimisticMessage({
			id: detail.messageId,
			conversationId: detail.conversationId,
			role: "assistant",
			content: detail.content,
			runId: detail.runId,
			parentMessageId: detail.parentMessageId,
		});
		messages = [
			...messages.filter((m) => m.id !== `streaming-${detail.runId}`),
			realMsg,
		];

		const nextPlaceholder = makeOptimisticMessage({
			id: `streaming-${detail.runId}`,
			conversationId: detail.conversationId,
			role: "assistant",
			runId: detail.runId,
			parentMessageId: detail.messageId,
		});
		messages = [...messages, nextPlaceholder];

		queueMicrotask(() => {
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		});
	}

	function handleClientTool(e: Event) {
		const detail = (e as CustomEvent).detail as
			| {
					conversationId?: string;
					toolCallId?: string;
					toolName?: string;
					input?: unknown;
			  }
			| undefined;
		if (!detail) return;
		if (detail.conversationId !== conversationId) return;

		const toolCallId = String(detail.toolCallId ?? "");
		const toolName = String(detail.toolName ?? "");
		void (async () => {
			// Round-trip the dispatch result back to the runtime so the
			// suspended `fill_form` / `navigate_to` Promise can resolve.
			// Without the POST the agent loop hangs on the deferred tool
			// call until the registry's 5-min timeout fires. We always
			// POST something — even on dispatcher failure — so the
			// runtime gets a concrete failure signal rather than waiting
			// out the timeout.
			let dispatchResult: unknown;
			try {
				dispatchResult = await dispatchClientTool(
					{
						conversationId: detail.conversationId!,
						toolCallId,
						toolName,
						input: detail.input,
					},
					{ goto },
				);
			} catch (err) {
				// Dispatcher should never throw (it returns DispatchResult
				// on every path), but guard defensively so a future
				// regression can't leak an exception into the SSE handler.
				dispatchResult = {
					ok: false,
					toolName,
					toolCallId,
					error: (err as Error)?.message ?? "dispatcher threw",
					code: "rejected",
				};
			}
			if (!toolCallId || !conversationId) return;
			try {
				await fetch(
					`/api/conversations/${encodeURIComponent(conversationId)}/tool-results`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ toolCallId, result: dispatchResult }),
					},
				);
			} catch {
				// Network failure — the registry's 5-min timeout is the
				// fallback. We swallow the error rather than surface it in
				// the panel because the user typically can't act on it.
			}
		})();
	}

	// `run:complete` is observable via the global store: when the active
	// runId's slots disappear, `stopStreaming` ran. Refetch the message
	// list at that point so any final tool calls / persisted turns land.
	let lastObservedActiveRun = $state<string | null>(null);
	$effect(() => {
		const runId = activeRunId;
		if (!runId) {
			lastObservedActiveRun = null;
			return;
		}
		// Started streaming (or re-attached after navigation): track it.
		if (lastObservedActiveRun !== runId) {
			lastObservedActiveRun = runId;
			return;
		}
		// Same runId, but the streaming slot disappeared — completion.
		if (
			store.streamingMessages[runId] === undefined &&
			store.streamingStatus[runId] === undefined
		) {
			activeRunId = null;
			lastObservedActiveRun = null;
			void refreshMessages();
		}
	});

	$effect(() => {
		if (!panelOpen) return;
		void (async () => {
			await ensureConversation();
			const prefill = consumePendingPrompt();
			if (prefill) pendingPrefill = prefill;
			await refreshMessages();
		})();
	});

	// Detach any in-flight streaming run when the panel closes so we
	// don't keep an open subscription for a hidden surface.
	$effect(() => {
		if (!panelOpen && activeRunId) {
			stopStreaming(activeRunId);
			activeRunId = null;
		}
	});

	onMount(() => {
		if (panelOpen && !conversationId) void ensureConversation();
		if (typeof window !== "undefined") {
			window.addEventListener("ez:turn_saved", handleTurnSaved);
			window.addEventListener("ez:client-tool", handleClientTool);
		}
	});

	onDestroy(() => {
		if (typeof window !== "undefined") {
			window.removeEventListener("ez:turn_saved", handleTurnSaved);
			window.removeEventListener("ez:client-tool", handleClientTool);
		}
		if (activeRunId) stopStreaming(activeRunId);
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
					<button
						type="button"
						class="ez-panel__icon-btn"
						aria-label="Clear conversation"
						title="Clear conversation — start fresh"
						data-testid="ez-panel-clear"
						disabled={clearing}
						onclick={() => void handleClear()}
					>
						<Trash2 size={16} aria-hidden="true" />
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
					{@const isStreamingMsg =
						msg.id === `streaming-${activeRunId}` && isStreaming}
					<div data-testid="ez-message" data-role={msg.role}>
						<ChatMessage
							message={msg}
							streamingText={isStreamingMsg ? currentStreamingText : undefined}
							streamingStatus={isStreamingMsg ? currentStreamingStatus : undefined}
							conversationId={conversationId ?? undefined}
							onsendmessage={(text) => void send(text)}
						/>
					</div>
				{/each}
			{/if}
		</div>

		{#if error}
			<div class="ez-panel__error" role="alert">{error}</div>
		{/if}

		<ChatInput
			placeholder="Ask Ez to do something for you…"
			disabled={!conversationId}
			streaming={isStreaming}
			lockedMode={{ modeSlug: 'ez', label: 'Ez' }}
			initialValue={pendingPrefill}
			autofocus
			{selectedModel}
			onmodelchange={handleModelChange}
			onautoselect={handleModelAutoSelect}
			{thinkingLevel}
			onthinkinglevelchange={handleThinkingLevelChange}
			{modelSupportsReasoning}
			onreasoningchange={handleReasoningChange}
			onsubmit={(content) => { void send(content); }}
			onstop={() => { if (activeRunId) stopStreaming(activeRunId); activeRunId = null; }}
		/>
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
	.ez-panel__icon-btn {
		background: transparent;
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
		cursor: pointer;
		padding: 0.25rem 0.4rem;
		border-radius: 0.35rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 0;
	}
	.ez-panel__icon-btn:hover:not(:disabled) {
		color: var(--color-text-primary);
		background: var(--color-surface-tertiary);
	}
	.ez-panel__icon-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ez-panel__messages {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem 0;
		display: flex;
		flex-direction: column;
	}
	.ez-panel__empty {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		padding: 0.75rem 1rem;
	}
	.ez-panel__error {
		color: #d44a4a;
		background: rgba(212, 74, 74, 0.08);
		border-top: 1px solid rgba(212, 74, 74, 0.2);
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
	}
</style>
