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
	import { ezPanelState, closeEzPanel, consumePendingPrompt } from "$lib/ez/panel-store.svelte.js";
	import { getOrCreateEzConversation, clearEzConversation } from "$lib/ez/api.js";
	import Trash2 from "lucide-svelte/icons/trash-2";
	import { dispatch as dispatchClientTool } from "$lib/ez/client-tool-dispatcher.js";
	import { groupToolsByExtension, buildExtensionTypeMap, type LoadedTool } from "$lib/loaded-tools-logic.js";
	import { goto as appGoto } from "$app/navigation";
	import { fetchAllMessages, sendMessage, type Message } from "$lib/api.js";
	import {
		store,
		startStreaming,
		stopStreaming,
		getStreamingToolCalls,
		getStreamingAgentCalls,
		getStreamingContentBlocks,
	} from "$lib/stores.svelte.js";
	import { inlineToolStore } from "$lib/inline-tool-store.svelte.js";
	import ChatInput from "$lib/components/ChatInput.svelte";
	import ChatMessage from "$lib/components/ChatMessage.svelte";
	import { buildHistoricalBlocks } from "$lib/content-blocks.js";
	import { hydrateToolCallsFromApiData, type MessagesWithToolCallsResponse } from "$lib/chat/page-handlers/load-messages.js";
	import { getHistoricalToolCalls } from "$lib/chat/historical-tool-calls.js";
	import { filterEmptyAssistantTurns } from "$lib/chat/filter-empty-turns.js";

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

	// Quick-start suggestions surfaced when the conversation is empty —
	// gives new users a concrete sense of what Ez can do for them. Each
	// click pre-fills the composer (does not auto-send) so users can
	// tweak before submitting. Clicks are no-ops once the user has typed
	// their own text — see ChatInput's `initialValue` effect.
	const EMPTY_STATE_SUGGESTIONS: { label: string; prompt: string }[] = [
		{ label: "Create a new project", prompt: "Help me create a new project." },
		{ label: "Build a new agent", prompt: "Help me build a new agent." },
		{ label: "Install an extension", prompt: "Help me find and install an extension." },
		{ label: "Summarize my recent activity", prompt: "Summarize my recent conversations and activity." },
	];

	function applySuggestion(prompt: string) {
		pendingPrefill = prompt;
	}
	// "Clear conversation" in-flight flag. Disables the button and
	// short-circuits a double-click while the DELETE round-trips.
	let clearing = $state<boolean>(false);

	// Inline click-to-confirm for the destructive "clear" action. We
	// deliberately do NOT use native `window.confirm()` here: browsers
	// silently suppress repeated page dialogs (the "Don't allow this page
	// to prompt you again" state) and some embedded/webview contexts block
	// them outright — in those cases `confirm()` returns `false` with no
	// visible prompt, so the button appeared to "do nothing" on click.
	// The inline two-step confirm mirrors the codebase's existing
	// dialog-free pattern (LessonsTab / SubstackReviewCard) and is
	// deterministically testable. First click arms; a second click within
	// CLEAR_CONFIRM_MS performs the wipe; the arm auto-resets after the
	// timeout (or when the panel closes).
	let clearConfirming = $state<boolean>(false);
	let clearConfirmTimer: ReturnType<typeof setTimeout> | undefined;
	const CLEAR_CONFIRM_MS = 3000;

	// ── Header tools chip ────────────────────────────────────────────
	//
	// Surfaces the tools actually wired for this Ez conversation (the same
	// list the runtime grants — GET /api/tools?conversationId=… resolves
	// the mode+conversation scope). Fetched lazily on first popover open so
	// the panel's initial render stays cheap. Reuses the chat header's
	// grouping logic (loaded-tools-logic.ts) so the two surfaces can't drift.
	// Non-fatal: a fetch error just shows an inline message.
	let toolsOpen = $state(false);
	let toolsFetched = $state(false);
	let toolsError = $state(false);
	let loadedTools = $state<LoadedTool[]>([]);
	let toolsByExtension = $derived(groupToolsByExtension(loadedTools));
	let toolExtensionTypes = $derived(buildExtensionTypeMap(loadedTools));

	async function toggleTools() {
		toolsOpen = !toolsOpen;
		if (!toolsOpen || toolsFetched || !conversationId) return;
		toolsFetched = true;
		try {
			const res = await fetch(`/api/tools?conversationId=${encodeURIComponent(conversationId)}`);
			if (!res.ok) {
				toolsError = true;
				return;
			}
			const data = await res.json();
			loadedTools = Array.isArray(data?.tools) ? data.tools : [];
		} catch {
			toolsError = true;
		}
	}

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

	// EzPanel doesn't render <MemoriesCard> and never spawns sub-agents, so
	// `isMemoryCardVisible` is always false and `getHistoricalAgentCalls`
	// always returns no entries. Empty assistant turns whose only signal is
	// `memoriesUsed` would be invisible here — hide them. Tool-only / agent
	// turns are kept by the hydrated tool-call check below.
	let renderableMessages = $derived(
		filterEmptyAssistantTurns(messages, {
			hasHistoricalToolCalls: (id) => getHistoricalToolCalls(id).length > 0,
			hasHistoricalAgentCalls: () => false,
			isMemoryCardVisible: () => false,
		}),
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
			// Hydrate historical tool calls so empty-content / tool-only turns
			// can render their cards (without this they collapse to a blank
			// bubble shell — the user-reported regression). Fire-and-forget;
			// hydration failure is non-fatal.
			void hydrateHistoricalToolCalls();
		} catch (e) {
			// Non-fatal — stale message list won't crash the panel.
			console.warn("Ez panel refresh failed", e);
		}
	}

	/**
	 * Pull `?withToolCalls=true` and push the rows into `inlineToolStore`.
	 * Mirrors the chat page's `hydrateToolCallsFromApi` (W7 of the chat-page
	 * split) but inlined here because the panel doesn't need the LoadMessages
	 * host abstractions — only the historical-tool-call slice. The dedup
	 * `messages-tools:<cid>` key is shared with the main page's hydrate so
	 * fetch-policy collapses duplicate calls when both surfaces are open.
	 */
	async function hydrateHistoricalToolCalls(): Promise<void> {
		const cid = conversationId;
		if (!cid) return;
		try {
			const res = await fetch(`/api/conversations/${cid}/messages?withToolCalls=true`);
			if (!res.ok) return;
			const data = (await res.json()) as MessagesWithToolCallsResponse;
			const bundle = hydrateToolCallsFromApiData(data);
			inlineToolStore.hydrateToolCalls(cid, bundle.hydrateInput);
		} catch {
			// Hydration is purely additive UI — swallow.
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
			});

			// Replace the optimistic user message with the real persisted one.
			messages = messages.map((m) =>
				m.id === optimisticUserMsg.id ? result.userMessage : m,
			);

			// Action-only submissions (`![EZ:*]` tokens with no surrounding
			// prose) skip the LLM call server-side, so there's no run to
			// stream and `runId` comes back null. Short-circuit the
			// streaming setup and reconcile from the persisted tree — same
			// contract the chat page's send-message handler honors.
			if (result.runId === null) {
				activeRunId = null;
				await refreshMessages();
				return;
			}

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
	 * "Clear conversation / start fresh" — first click of a two-step
	 * inline confirm. Arming morphs the trash button into a red
	 * "Confirm?" affordance for CLEAR_CONFIRM_MS; a second click within
	 * that window runs {@link performClear}. See `clearConfirming` above
	 * for why this is dialog-free (native `confirm()` silently no-ops
	 * under browser dialog-suppression, which is the bug this fixes).
	 */
	function handleClearClick(): void {
		if (clearing) return;
		if (!conversationId) return;
		if (clearConfirming) {
			cancelClearConfirm();
			void performClear();
			return;
		}
		clearConfirming = true;
		clearTimeout(clearConfirmTimer);
		clearConfirmTimer = setTimeout(() => {
			clearConfirming = false;
		}, CLEAR_CONFIRM_MS);
	}

	/** Disarm the pending clear-confirm (timeout, cancel, or panel close). */
	function cancelClearConfirm(): void {
		clearTimeout(clearConfirmTimer);
		clearConfirming = false;
	}

	/**
	 * Wipes every message on the server side and resets the panel's local
	 * view to an empty state. The conversation id stays the same (schema
	 * enforces one Ez convo per user), so the panel's SSE subscription and
	 * locked mode all keep working unchanged. The composer's
	 * typed-but-unsent prompt is left as-is so the user doesn't lose their
	 * draft.
	 */
	async function performClear(): Promise<void> {
		if (clearing) return;
		if (!conversationId) return;
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

	// Disarm a pending clear-confirm whenever the panel closes so a stale
	// "Confirm?" state can't survive a close/reopen.
	$effect(() => {
		if (!panelOpen && clearConfirming) cancelClearConfirm();
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
		clearTimeout(clearConfirmTimer);
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
					<div class="ez-panel__tools">
						<button
							type="button"
							class="ez-panel__link ez-panel__tools-btn"
							aria-label={`Ez tools (${loadedTools.length})`}
							aria-expanded={toolsOpen}
							title="Tools Ez can use in this conversation"
							data-testid="ez-panel-tools"
							onclick={() => void toggleTools()}
						>
							<span aria-hidden="true">🔧</span>
							{#if toolsFetched && !toolsError}<span class="ez-panel__tools-count">{loadedTools.length}</span>{/if}
						</button>
						{#if toolsOpen}
							<button
								type="button"
								class="ez-panel__tools-backdrop"
								aria-label="Close tools list"
								data-testid="ez-panel-tools-backdrop"
								onclick={() => (toolsOpen = false)}
							></button>
							<div class="ez-panel__tools-popover" data-testid="ez-panel-tools-popover">
								{#if toolsError}
									<p class="ez-panel__tools-empty">Couldn't load the tool list.</p>
								{:else if loadedTools.length === 0}
									<p class="ez-panel__tools-empty">No tools loaded.</p>
								{:else}
									{#each [...toolsByExtension] as [ext, tools] (ext)}
										{@const extType = toolExtensionTypes.get(ext) ?? "extension"}
										<div class="ez-panel__tools-group">
											<p class="ez-panel__tools-group-header" data-testid="ez-panel-tools-group">
												<span class="ez-panel__tools-ext">{ext}</span>
												<span class="ez-panel__tools-type">{extType}</span>
											</p>
											{#each tools as tool (tool.name)}
												<p
													class="ez-panel__tools-row"
													data-testid="ez-panel-tool-row"
													title={tool.description || "No description provided."}
												>
													{tool.name}
												</p>
											{/each}
										</div>
									{/each}
								{/if}
							</div>
						{/if}
					</div>
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
						class:ez-panel__icon-btn--confirming={clearConfirming}
						aria-label={clearConfirming ? "Confirm clear conversation" : "Clear conversation"}
						title={clearConfirming
							? "Click again to delete all messages"
							: "Clear conversation — start fresh"}
						data-testid="ez-panel-clear"
						data-confirming={clearConfirming}
						disabled={clearing}
						onclick={() => handleClearClick()}
					>
						<Trash2 size={16} aria-hidden="true" />
						{#if clearConfirming}<span class="ez-panel__icon-btn-label">Confirm?</span>{/if}
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
				<div class="ez-panel__empty" data-testid="ez-panel-empty">
					<p class="ez-panel__empty-lead">
						Hi! I'm Ez — your in-app concierge. Here are a few things I can do:
					</p>
					<ul class="ez-panel__suggestions">
						{#each EMPTY_STATE_SUGGESTIONS as s}
							<li>
								<button
									type="button"
									class="ez-panel__suggestion"
									data-testid="ez-panel-suggestion"
									onclick={() => applySuggestion(s.prompt)}
								>
									{s.label}
								</button>
							</li>
						{/each}
					</ul>
					<p class="ez-panel__empty-hint">
						Tap one to pre-fill the composer, or just type what you need —
						I can also fill forms and navigate you around the app.
					</p>
				</div>
			{:else}
				{#each renderableMessages as msg (msg.id)}
					{@const isStreamingMsg =
						msg.id === `streaming-${activeRunId}` && isStreaming}
					{@const streamingTools = isStreamingMsg && activeRunId ? getStreamingToolCalls(activeRunId) : undefined}
					{@const streamingAgents = isStreamingMsg && activeRunId ? getStreamingAgentCalls(activeRunId) : undefined}
					{@const streamingBlocks = isStreamingMsg && activeRunId ? getStreamingContentBlocks(activeRunId) : undefined}
					{@const historicalTools = !isStreamingMsg && msg.role === 'assistant' ? getHistoricalToolCalls(msg.id) : undefined}
					{@const msgToolCalls = (streamingTools && streamingTools.length > 0)
						? streamingTools
						: (historicalTools && historicalTools.length > 0 ? historicalTools : undefined)}
					{@const msgContentBlocks = (streamingBlocks && streamingBlocks.length > 0)
						? streamingBlocks
						: ((historicalTools && historicalTools.length > 0) || msg.thinkingContent
							? buildHistoricalBlocks(msg.content, historicalTools?.length ?? 0, 0, msg.thinkingContent)
							: undefined)}
					<div data-testid="ez-message" data-role={msg.role} data-message-id={msg.id}>
						<ChatMessage
							message={msg}
							streamingText={isStreamingMsg ? currentStreamingText : undefined}
							streamingStatus={isStreamingMsg ? currentStreamingStatus : undefined}
							toolCalls={msgToolCalls}
							agentCalls={streamingAgents && streamingAgents.length > 0 ? streamingAgents : undefined}
							contentBlocks={msgContentBlocks}
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
	.ez-panel__tools { position: relative; display: inline-flex; }
	.ez-panel__tools-btn { display: inline-flex; align-items: center; gap: 0.2rem; }
	.ez-panel__tools-count { font-variant-numeric: tabular-nums; }
	.ez-panel__tools-backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: transparent;
		border: none;
		padding: 0;
		cursor: default;
	}
	.ez-panel__tools-popover {
		position: absolute;
		top: 100%;
		right: 0;
		z-index: 50;
		margin-top: 0.35rem;
		width: 16rem;
		max-height: 18rem;
		overflow-y: auto;
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		background: var(--color-surface-secondary);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
	}
	.ez-panel__tools-empty {
		margin: 0;
		padding: 0.5rem 0.75rem;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}
	.ez-panel__tools-group { padding: 0.5rem 0.75rem; }
	.ez-panel__tools-group + .ez-panel__tools-group { border-top: 1px solid var(--color-border); }
	.ez-panel__tools-group-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin: 0 0 0.25rem 0;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--color-text-secondary);
	}
	.ez-panel__tools-ext { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ez-panel__tools-type {
		flex-shrink: 0;
		text-transform: uppercase;
		font-size: 0.5625rem;
		font-weight: 600;
		padding: 0.05rem 0.25rem;
		border-radius: 0.25rem;
		background: var(--color-surface-tertiary);
		color: var(--color-text-muted);
	}
	.ez-panel__tools-row {
		margin: 0;
		padding: 0.1rem 0 0.1rem 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
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
	/* Armed destructive-confirm state — red so a second click reads as
	   "this deletes everything". Matches the click-to-confirm styling used
	   for lesson/knowledge-base deletes. */
	.ez-panel__icon-btn--confirming,
	.ez-panel__icon-btn--confirming:hover:not(:disabled) {
		gap: 0.3rem;
		border-color: #d44a4a;
		background: rgba(212, 74, 74, 0.12);
		color: #d44a4a;
	}
	.ez-panel__icon-btn-label {
		font-size: 0.7rem;
		font-weight: 600;
		line-height: 1;
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
	.ez-panel__empty-lead {
		margin: 0 0 0.5rem 0;
		color: var(--color-text-secondary, var(--color-text-primary));
	}
	.ez-panel__empty-hint {
		margin: 0.75rem 0 0 0;
		font-size: 0.8125rem;
	}
	.ez-panel__suggestions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.ez-panel__suggestion {
		width: 100%;
		text-align: left;
		background: var(--color-surface-secondary);
		border: 1px solid var(--color-border);
		color: var(--color-text-primary);
		padding: 0.5rem 0.75rem;
		border-radius: 0.4rem;
		font-size: 0.875rem;
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease;
	}
	.ez-panel__suggestion:hover {
		background: var(--color-surface-tertiary);
		border-color: var(--color-text-muted);
	}
	.ez-panel__suggestion:focus-visible {
		outline: 2px solid var(--color-accent, #4c8cff);
		outline-offset: 2px;
	}
	.ez-panel__error {
		color: #d44a4a;
		background: rgba(212, 74, 74, 0.08);
		border-top: 1px solid rgba(212, 74, 74, 0.2);
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
	}
</style>
