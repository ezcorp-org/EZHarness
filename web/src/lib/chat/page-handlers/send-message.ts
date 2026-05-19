/**
 * Send-message handler family — extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W7 of the chat-page
 * split).
 *
 * Five handler clusters live here:
 *
 *   1. `handleSend(content, attachments?)` — the big one. Orchestrates the
 *      OAuth code-paste flow, `/login` and `/model` slash commands,
 *      optimistic user message creation, the actual `sendMessage` POST,
 *      streaming start, conversation auto-titling, and `@agent` mention
 *      detection that triggers a sub-conversation.
 *
 *   2. `handleEditConfirm(msg)` and `handleRegenerate(msg)` — both fork
 *      the active branch by passing `editOf` to `sendMessage`. Edit fires
 *      on user-message edit submit; regenerate fires on assistant-message
 *      regenerate. Tree mutation + streaming start are the same in each.
 *
 *   3. `handleBranchNavigate(messageId)` — sets `activeLeafId` to the leaf
 *      of the branch containing the given message. Tightly coupled to the
 *      edit/regenerate cluster (siblings produced by edit/regenerate are
 *      navigated via this).
 *
 *   4. `handleSaveMemory(msg)` — POST `/api/memories` with a single
 *      message's content. Distinct from `useSelectMode`'s
 *      `handleBulkSaveMemory` which combines many messages into one
 *      memory entry.
 *
 *   5. `handleRetry(msg)` and `handleFallback(msg, provider, model)` — both
 *      remove a failed assistant turn and re-`handleSend` the preceding
 *      user message. Fallback temporarily overrides the selected model;
 *      retry uses whatever the user currently has selected.
 *
 *   6. Sub-conversation handlers (`handleSubConvoSend`,
 *      `handleSubConvoReturn`, `startSubConvo`) — the page used to call
 *      these directly; they're now grouped here so the `@agent`
 *      sub-convo trigger from `handleSend` and the standalone Send /
 *      Return buttons share one module.
 *
 * The module never imports `$lib/stores.svelte.js`'s `store` proxy; it
 * pulls in only `startStreaming` (call-only — no read coupling). All
 * reactive state lives in the page; the host plumbs slot getters/setters
 * for everything that gets mutated.
 *
 * # Why a host
 *
 * The handlers mutate ~15 page-level slots (allMessages, activeLeafId,
 * activeRunId, activeRunStartedAt, serverStalenessMs, resumedRun, error,
 * chatOAuthPending, userScrolledUp, editingMessageId, editContent,
 * settingsOpen, obsOpen, editRetryCall, editRetryTool, savedMemories) and
 * read another ~6 (selectedModel, permissionModeOverride, thinkingLevel,
 * modelSupportsReasoning, allMessages, activeLeafId). Plumbing each one
 * as a get/set slot — instead of a reactive proxy — keeps this module a
 * plain `.ts` file. The test file drives every code path with no Svelte
 * runtime present.
 *
 * The page is the source of truth for `allMessages` / `activeLeafId`
 * etc.; the host accessors read fresh on every call so the handlers
 * never see a stale snapshot. Tests assert this by mutating host getters
 * between calls.
 *
 * # Sentinel ref
 *
 * `host.sentinel()` returns the live DOM ref — read fresh inside
 * `requestAnimationFrame` so the optimistic-scroll lands after the
 * just-pushed user bubble has been rendered. The plan's risk register
 * called this out explicitly: passing the ref by value at factory time
 * would capture `undefined` (the page binds it via `bind:this` after the
 * initial render).
 *
 * # parseMentions
 *
 * `parseMentions` is run on the literal user-typed `content` string. It
 * is NEVER re-run on the post-expansion text (that would be a
 * security-shaped regression — slash-command bodies can legitimately
 * contain `!`, `@`, `/` characters that look like mentions but should
 * not be parsed). Mirrors the wiring in `src/runtime/mention-wiring.ts`
 * where command expansion is literal.
 */

import {
	createSubConversation,
	sendMessage,
	updateConversation,
	type Message,
} from "$lib/api.js";
import {
	startOAuthFlow,
	completeOAuthWithCode,
	isLoginCommand,
	type OAuthPending,
} from "$lib/oauth.js";
import { isModelCommand } from "$lib/commands.js";
import { startStreaming } from "$lib/stores.svelte.js";
import { subConversationStore } from "$lib/sub-conversation-store.svelte.js";
import { parseMentions } from "$lib/mention-logic.js";
import { userFetch } from "$lib/utils/fetch-policy.js";
import type { SubConvoRecord } from "$lib/sub-convo-agent-state.js";
import type { PermissionMode } from "$lib/permission-mode.js";
import type { InlineToolCall } from "$lib/inline-tool-store.svelte.js";
import type { ToolDefinition } from "../../../../../src/extensions/types";
import type {
	ComputeLatestLeaf as ComputeLatestLeafType,
	FindLeafByMessageId as FindLeafByMessageIdType,
} from "./load-messages.js";

// Provider display labels mirror the page's local map. Kept here so
// `addSystemMessage` strings format provider names consistently across
// `handleSend`'s OAuth and `/login` arms.
const PROVIDER_DISPLAY: Record<string, string> = {
	openai: "OpenAI",
	google: "Google Gemini",
	anthropic: "Anthropic",
};

// ── Slot types ───────────────────────────────────────────────────────────

export interface Slot<T> {
	get(): T;
	set(v: T): void;
}

export interface SelectedModel {
	provider: string;
	model: string;
}

/**
 * Tree-walk helpers re-exported from W5's `load-messages.ts`. Re-exported
 * (rather than locally redeclared) so the host signature stays in sync
 * with the actual implementation — `findLeafByMessageId` returns `string`,
 * not `string | null`, and an earlier local copy got that wrong.
 */
export type ComputeLatestLeaf = ComputeLatestLeafType;
export type FindLeafByMessageId = FindLeafByMessageIdType;

export interface SendMessageHost {
	// ── Conversation / project context ─────────────────────────────────
	convId(): string;
	projectId(): string;

	// ── Model / mode / reasoning ──────────────────────────────────────
	selectedModel: Slot<SelectedModel | null>;
	permissionModeOverride: Slot<PermissionMode | undefined>;
	thinkingLevel: Slot<string>;
	modelSupportsReasoning(): boolean;

	// ── Message tree ──────────────────────────────────────────────────
	allMessages: Slot<Message[]>;
	activeLeafId: Slot<string | null>;
	/**
	 * Active path from root → activeLeafId. Computed by the page as a
	 * `$derived` over `allMessages` + `activeLeafId`. Read by
	 * `handleRegenerate`, `handleRetry`, `handleFallback` (siblings &
	 * preceding user-message walks).
	 */
	messages(): Message[];

	// ── Edit state (live while user is in inline edit mode) ───────────
	editingMessageId: Slot<string | null>;
	editContent: Slot<string>;

	// ── Active run lifecycle ──────────────────────────────────────────
	activeRunId: Slot<string | null>;
	activeRunStartedAt: Slot<number | null>;
	serverStalenessMs: Slot<number | null>;
	resumedRun: Slot<boolean>;

	// ── UI state ──────────────────────────────────────────────────────
	error: Slot<string | null>;
	chatOAuthPending: Slot<OAuthPending | null>;
	userScrolledUp: Slot<boolean>;
	settingsOpen: Slot<boolean>;
	obsOpen: Slot<boolean>;
	editRetryCall: Slot<InlineToolCall | null>;
	editRetryTool: Slot<ToolDefinition | null>;

	// ── Saved memories (single-message save) ──────────────────────────
	savedMemories: Slot<Map<string, string>>;

	// ── Sub-conversation list (for `startSubConvo`) ───────────────────
	subConversations: Slot<SubConvoRecord[]>;

	// ── DOM refs (read fresh inside `requestAnimationFrame`) ──────────
	sentinel(): HTMLElement | null | undefined;
	convList(): { refresh?: () => void } | null | undefined;

	// ── Helpers the page owns and the handlers must call ──────────────
	addSystemMessage(text: string): void;
	loadMessages(): Promise<void>;
	makeOptimisticMessage(
		overrides: Partial<Message> & Pick<Message, "conversationId">,
	): Message;
	/**
	 * Apply a model selection. The page's implementation persists to
	 * localStorage and PATCHes the conversation row; tests stub it to a
	 * plain setter and assert the call.
	 */
	handleModelChange(provider: string, model: string): void;
	computeLatestLeaf: ComputeLatestLeaf;
	findLeafByMessageId: FindLeafByMessageId;
}

// ── Return shape ─────────────────────────────────────────────────────────

export interface SendMessageHandlers {
	handleSend(content: string, attachments?: File[]): Promise<void>;
	handleEditConfirm(msg: Message): Promise<void>;
	handleRegenerate(msg: Message): Promise<void>;
	handleRerun(msg: Message): Promise<void>;
	handleBranchNavigate(messageId: string): void;
	handleSaveMemory(msg: Message): Promise<void>;
	handleRetry(msg: Message): Promise<void>;
	handleFallback(
		msg: Message,
		provider: string,
		model: string,
	): Promise<void>;
	// Sub-conversation cluster — moved here so the `@agent` trigger in
	// `handleSend` and the standalone Send / Return buttons share one
	// module.
	handleSubConvoSend(text: string): Promise<void>;
	handleSubConvoReturn(): Promise<void>;
	startSubConvo(
		agentMention: { name: string },
		parentMessageId: string,
	): Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────────

export function makeSendMessage(host: SendMessageHost): SendMessageHandlers {
	async function handleSend(
		content: string,
		attachments?: File[],
	): Promise<void> {
		const convId = host.convId();
		if (!convId) return;

		// Close all page-level panels and forms — matches the original
		// page behavior. Sending a message is the user's signal that
		// they're done with whatever side panel was open.
		host.settingsOpen.set(false);
		host.obsOpen.set(false);
		host.editRetryCall.set(null);
		host.editRetryTool.set(null);

		// Handle OAuth code paste (if pending). This branches BEFORE the
		// /login and /model command parsers so a pasted callback URL
		// that happens to contain "/model" or "/login" doesn't fork into
		// the wrong arm.
		const pending = host.chatOAuthPending.get();
		if (pending) {
			const result = await completeOAuthWithCode(pending, content);
			host.chatOAuthPending.set(null);
			if (result.success) {
				host.addSystemMessage(
					`${PROVIDER_DISPLAY[result.provider] ?? result.provider} connected successfully!`,
				);
			} else {
				host.addSystemMessage(`OAuth failed: ${result.error}`);
			}
			return;
		}

		// Handle /login commands before sending to API.
		const loginCmd = isLoginCommand(content);
		if (loginCmd !== null) {
			const { provider } = loginCmd;
			if (!provider) {
				host.addSystemMessage("Usage: /login openai or /login google");
				return;
			}
			if (provider === "anthropic") {
				host.addSystemMessage(
					"OAuth is not available for Anthropic. Please add your API key in Settings or use /config.",
				);
				return;
			}
			if (provider === "openai" || provider === "google") {
				try {
					const oauthPending = await startOAuthFlow(provider);
					host.chatOAuthPending.set(oauthPending);
					window.open(oauthPending.authUrl, "_blank");
					host.addSystemMessage(
						`Opening ${PROVIDER_DISPLAY[provider] ?? provider} login... Authentication should complete automatically. If it doesn't, paste the callback URL here.`,
					);
				} catch (err) {
					host.addSystemMessage(
						`Failed to start OAuth: ${err instanceof Error ? err.message : "unknown error"}`,
					);
				}
				return;
			}
			// Unknown provider
			host.addSystemMessage("Usage: /login openai or /login google");
			return;
		}

		// Handle /model commands.
		const modelCmd = isModelCommand(content);
		if (modelCmd !== null) {
			const selectedModel = host.selectedModel.get();
			if (modelCmd.type === "list") {
				try {
					const res = await fetch("/api/models");
					if (!res.ok) throw new Error("Failed to fetch models");
					const data: Array<{
						provider: string;
						model: string;
						displayName?: string;
						available: boolean;
					}> = await res.json();
					const available = data.filter((m) => m.available);
					if (available.length === 0) {
						host.addSystemMessage(
							"No models available. Add API keys in Settings.",
						);
					} else {
						const lines = available.map(
							(m) =>
								`  ${m.provider}/${m.model}${
									m.displayName ? ` (${m.displayName})` : ""
								}`,
						);
						const current = selectedModel
							? `Current: ${selectedModel.provider}/${selectedModel.model}`
							: "No model selected";
						host.addSystemMessage(
							`Available models:\n${lines.join(
								"\n",
							)}\n\n${current}\n\nUsage: /model provider/model-name`,
						);
					}
				} catch {
					host.addSystemMessage("Failed to fetch available models.");
				}
				return;
			}

			// type === "switch"
			try {
				const res = await fetch("/api/models");
				if (!res.ok) throw new Error("Failed to fetch models");
				const data: Array<{
					provider: string;
					model: string;
					available: boolean;
				}> = await res.json();
				const available = data.filter((m) => m.available);

				let found: { provider: string; model: string } | null = null;

				if (modelCmd.provider) {
					found =
						available.find(
							(m) =>
								m.provider === modelCmd.provider &&
								m.model === modelCmd.model,
						) ?? null;
				} else {
					const matches = available.filter(
						(m) => m.model === modelCmd.model,
					);
					if (matches.length === 1) {
						found = matches[0]!;
					} else if (matches.length > 1) {
						const opts = matches
							.map((m) => `  ${m.provider}/${m.model}`)
							.join("\n");
						host.addSystemMessage(
							`Multiple models match "${modelCmd.model}":\n${opts}\n\nSpecify the provider: /model provider/${modelCmd.model}`,
						);
						return;
					}
				}

				if (found) {
					host.handleModelChange(found.provider, found.model);
					host.addSystemMessage(
						`Switched to ${found.provider}/${found.model}`,
					);
				} else {
					host.addSystemMessage(
						`Model not found: ${
							modelCmd.provider ? modelCmd.provider + "/" : ""
						}${modelCmd.model}\n\nType /model to see available models.`,
					);
				}
			} catch {
				host.addSystemMessage("Failed to fetch models for validation.");
			}
			return;
		}

		// Resolve activeLeafId. `streaming-<runId>` placeholders are never
		// persisted server-side, so they can't be a parent. Sending no
		// parent (null → undefined on the wire) makes the server anchor
		// the message to the conversation's real latest leaf — i.e. the
		// just-finished assistant turn. This is what closes the
		// stream-end → composer-re-enabled → pre-reconcile race: the
		// composer is gated off during an *active* stream, so in practice
		// the placeholder is only ever the active leaf in that post-stream
		// window, and deferring the parent to the server keeps the thread
		// linear instead of forking a side branch off the prior user
		// message (which `placeholder.parentMessageId` used to do).
		const activeLeafId = host.activeLeafId.get();
		const allMessagesNow = host.allMessages.get();
		let resolvedParentId: string | null = activeLeafId;
		if (resolvedParentId?.startsWith("streaming-")) {
			resolvedParentId = null;
		}

		// Optimistic user message linked to current leaf.
		const convIdNow = convId;
		const optimisticUserMsg = host.makeOptimisticMessage({
			id: `temp-${Date.now()}`,
			conversationId: convIdNow,
			role: "user",
			content,
			parentMessageId: resolvedParentId,
		});
		host.allMessages.set([...allMessagesNow, optimisticUserMsg]);
		host.activeLeafId.set(optimisticUserMsg.id);
		host.error.set(null);
		host.userScrolledUp.set(false);
		// Read sentinel fresh inside the rAF — the page binds it via
		// `bind:this` after the optimistic message renders. Capturing it
		// at factory time would be `undefined`.
		if (typeof requestAnimationFrame !== "undefined") {
			requestAnimationFrame(() => {
				host.sentinel()?.scrollIntoView({
					behavior: "instant" as ScrollBehavior,
				});
			});
		}

		try {
			const selectedModel = host.selectedModel.get();
			const result = await sendMessage(convIdNow, {
				content,
				provider: selectedModel?.provider,
				model: selectedModel?.model,
				parentMessageId: optimisticUserMsg.parentMessageId ?? undefined,
				permissionMode: host.permissionModeOverride.get(),
				thinkingLevel: host.modelSupportsReasoning()
					? host.thinkingLevel.get()
					: undefined,
				attachments,
			});

			// Replace optimistic user message with the real one. Merge
			// attachments from the top-level response field so the card
			// renders immediately even if the server skipped embedding
			// them on userMessage.
			const realUserMsg: Message =
				result.attachments && result.attachments.length > 0
					? { ...result.userMessage, attachments: result.attachments }
					: result.userMessage;
			host.allMessages.set(
				host.allMessages
					.get()
					.map((m) =>
						m.id === optimisticUserMsg.id ? realUserMsg : m,
					),
			);

			// EZ Actions v1: append synthetic `ez-action-result`
			// messages to chat history immediately so the result cards
			// render inline. Mirrors the optimistic-message pattern —
			// the server already persisted these rows; we just need the
			// client store to know about them so ChatMessage.svelte's
			// `role === "ez-action-result"` branch renders them. They
			// parent off the user message for branch-navigation parity.
			if (result.ezActionResults && result.ezActionResults.length > 0) {
				const ezMsgs: Message[] = result.ezActionResults.map((r) => ({
					id: r.id,
					conversationId: convIdNow,
					role: r.role,
					content: r.content,
					parentMessageId: realUserMsg.id,
					createdAt: new Date().toISOString(),
				} as Message));
				host.allMessages.set([
					...host.allMessages.get(),
					...ezMsgs,
				]);
			}

			// No-LLM mode: action-only message returned `runId: null`.
			// No assistant turn fires; skip the streaming setup
			// entirely. The result cards added above are the full UI
			// payload for this submission. We still update the active
			// leaf so subsequent messages parent correctly off the
			// user message (or the last result card, whichever is
			// chronologically last in the chat tree).
			if (result.runId === null) {
				const lastEz = result.ezActionResults?.[result.ezActionResults.length - 1];
				host.activeLeafId.set(lastEz?.id ?? realUserMsg.id);
				host.activeRunId.set(null);
				host.activeRunStartedAt.set(null);
				host.serverStalenessMs.set(null);
				return;
			}

			// Start streaming (returns false if run already errored).
			const started = startStreaming(result.runId, convIdNow);
			if (!started) {
				// Run completed/errored before POST returned — reconcile
				// by reloading the message tree.
				host.activeRunId.set(null);
				host.activeRunStartedAt.set(null);
				host.serverStalenessMs.set(null);
				await host.loadMessages();
				return;
			}
			host.activeRunId.set(result.runId);
			host.activeRunStartedAt.set(Date.now());
			host.serverStalenessMs.set(0);
			host.resumedRun.set(false);

			// Add placeholder assistant message.
			const assistantPlaceholder = host.makeOptimisticMessage({
				id: `streaming-${result.runId}`,
				conversationId: convIdNow,
				role: "assistant",
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId: result.runId,
				parentMessageId: result.userMessage.id,
			});
			host.allMessages.set([
				...host.allMessages.get(),
				assistantPlaceholder,
			]);
			host.activeLeafId.set(assistantPlaceholder.id);

			// Auto-set title from first user message.
			if (
				host.allMessages
					.get()
					.filter((m) => m.role === "user").length === 1
			) {
				const title =
					content.substring(0, 50) +
					(content.length > 50 ? "..." : "");
				updateConversation(convIdNow, { title })
					.then(() => host.convList()?.refresh?.())
					.catch(() => {});
			}

			// Detect @agent mentions and start sub-conversation. Run on
			// the LITERAL user-typed `content` — never on any
			// post-expansion text. Slash-command bodies can contain `!`
			// characters that look like mentions but must not be parsed.
			const mentions = parseMentions(content);
			const agentMention = mentions.find((m) => m.kind === "agent");
			if (agentMention) {
				startSubConvo(
					{ name: agentMention.name },
					result.userMessage.id,
				);
			}
		} catch (err) {
			host.error.set("Failed to send message");
			console.error(err);
			host.allMessages.set(
				host.allMessages
					.get()
					.filter((m) => m.id !== optimisticUserMsg.id),
			);
			// Restore previous leaf — the page's `computeLatestLeaf` walks
			// `allMessages` to find the most recently-created leaf.
			host.activeLeafId.set(
				host.computeLatestLeaf(host.allMessages.get()),
			);
		}
	}

	async function handleEditConfirm(msg: Message): Promise<void> {
		const convId = host.convId();
		const editContent = host.editContent.get();
		if (!convId || !editContent.trim()) return;
		host.editingMessageId.set(null);

		try {
			const selectedModel = host.selectedModel.get();
			const result = await sendMessage(convId, {
				content: editContent,
				provider: selectedModel?.provider,
				model: selectedModel?.model,
				editOf: msg.id,
				thinkingLevel: host.modelSupportsReasoning()
					? host.thinkingLevel.get()
					: undefined,
			});

			// Add the new user message to allMessages.
			host.allMessages.set([
				...host.allMessages.get(),
				result.userMessage,
			]);

			// Start streaming for the AI response. EZ Actions can return
			// `runId: null` for action-only messages, but this path
			// (handleEditConfirm) doesn't accept action-only messages
			// because the edit content already has tokens stripped at
			// the edit-input stage. Defensive narrowing here so the
			// downstream code can keep treating runId as non-null.
			if (result.runId === null) return;
			host.activeRunId.set(result.runId);
			host.activeRunStartedAt.set(Date.now());
			host.serverStalenessMs.set(0);
			startStreaming(result.runId, convId);

			// Add placeholder assistant message.
			const assistantPlaceholder = host.makeOptimisticMessage({
				id: `streaming-${result.runId}`,
				conversationId: convId,
				role: "assistant",
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId: result.runId,
				parentMessageId: result.userMessage.id,
			});
			host.allMessages.set([
				...host.allMessages.get(),
				assistantPlaceholder,
			]);
			host.activeLeafId.set(assistantPlaceholder.id);
		} catch (err) {
			host.error.set("Failed to edit message");
			console.error(err);
		}
	}

	async function handleRerun(msg: Message): Promise<void> {
		const convId = host.convId();
		if (!convId) return;
		if (msg.role !== "user") return;

		try {
			// Re-send the user message content unchanged with editOf
			// pointing to the user message itself — the server forks a
			// sibling user turn under the same parent, then streams a new
			// assistant response. Identical wire shape to a no-op edit;
			// the UX win is skipping the edit modal.
			const selectedModel = host.selectedModel.get();
			const result = await sendMessage(convId, {
				content: msg.content,
				provider: selectedModel?.provider,
				model: selectedModel?.model,
				editOf: msg.id,
				thinkingLevel: host.modelSupportsReasoning()
					? host.thinkingLevel.get()
					: undefined,
			});

			host.allMessages.set([
				...host.allMessages.get(),
				result.userMessage,
			]);

			if (result.runId === null) return;
			host.activeRunId.set(result.runId);
			host.activeRunStartedAt.set(Date.now());
			host.serverStalenessMs.set(0);
			startStreaming(result.runId, convId);

			const assistantPlaceholder = host.makeOptimisticMessage({
				id: `streaming-${result.runId}`,
				conversationId: convId,
				role: "assistant",
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId: result.runId,
				parentMessageId: result.userMessage.id,
			});
			host.allMessages.set([
				...host.allMessages.get(),
				assistantPlaceholder,
			]);
			host.activeLeafId.set(assistantPlaceholder.id);
		} catch (err) {
			host.error.set("Failed to re-run prompt");
			console.error(err);
		}
	}

	async function handleRegenerate(msg: Message): Promise<void> {
		const convId = host.convId();
		if (!convId) return;

		// Find the user message that preceded this assistant message in
		// the current path.
		const messagesNow = host.messages();
		const msgIndex = messagesNow.findIndex((m) => m.id === msg.id);
		if (msgIndex <= 0) return;
		const precedingUserMsg = messagesNow[msgIndex - 1];
		if (!precedingUserMsg || precedingUserMsg.role !== "user") return;

		try {
			// Re-send the user message content with editOf pointing to
			// the assistant message — the server forks a sibling.
			const selectedModel = host.selectedModel.get();
			const result = await sendMessage(convId, {
				content: precedingUserMsg.content,
				provider: selectedModel?.provider,
				model: selectedModel?.model,
				editOf: msg.id,
				thinkingLevel: host.modelSupportsReasoning()
					? host.thinkingLevel.get()
					: undefined,
			});

			// Add the new user message (sibling of the original).
			host.allMessages.set([
				...host.allMessages.get(),
				result.userMessage,
			]);

			// Start streaming. As above, this handler (handleRegenerate)
			// doesn't accept action-only EZ messages — narrow the
			// `runId | null` from sendMessage's return so downstream
			// code keeps the non-null assumption.
			if (result.runId === null) return;
			host.activeRunId.set(result.runId);
			host.activeRunStartedAt.set(Date.now());
			host.serverStalenessMs.set(0);
			startStreaming(result.runId, convId);

			// Add placeholder assistant.
			const assistantPlaceholder = host.makeOptimisticMessage({
				id: `streaming-${result.runId}`,
				conversationId: convId,
				role: "assistant",
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId: result.runId,
				parentMessageId: result.userMessage.id,
			});
			host.allMessages.set([
				...host.allMessages.get(),
				assistantPlaceholder,
			]);
			host.activeLeafId.set(assistantPlaceholder.id);
		} catch (err) {
			host.error.set("Failed to regenerate response");
			console.error(err);
		}
	}

	function handleBranchNavigate(messageId: string): void {
		// Navigate to the branch containing this message by finding its
		// leaf — a no-op if the id isn't anywhere in the tree.
		host.activeLeafId.set(
			host.findLeafByMessageId(host.allMessages.get(), messageId),
		);
	}

	async function handleSaveMemory(msg: Message): Promise<void> {
		try {
			const res = await userFetch("/api/memories", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: msg.content,
					category: "preferences",
					confidence: "medium",
				}),
			});
			if (res.status === 201) {
				const memory = await res.json();
				host.savedMemories.set(
					new Map(host.savedMemories.get()).set(msg.id, memory.id),
				);
			}
		} catch {
			// silent — same as original page
		}
	}

	async function handleRetry(msg: Message): Promise<void> {
		// Find by ID first, fall back to content match (handles stale
		// closure after reconcile).
		const messagesNow = host.messages();
		let idx = messagesNow.findIndex((m) => m.id === msg.id);
		if (idx < 0) {
			idx = messagesNow.findIndex(
				(m) => m.role === msg.role && m.content === msg.content,
			);
		}
		if (idx < 0) return;

		// Walk backwards to find the nearest user message.
		let userMsg: Message | undefined;
		for (let i = idx - 1; i >= 0; i--) {
			if (messagesNow[i]!.role === "user") {
				userMsg = messagesNow[i];
				break;
			}
		}
		if (!userMsg) return;

		host.allMessages.set(
			host.allMessages.get().filter((m) => m.id !== messagesNow[idx]!.id),
		);
		host.activeLeafId.set(host.computeLatestLeaf(host.allMessages.get()));
		await handleSend(userMsg.content);
	}

	async function handleFallback(
		msg: Message,
		provider: string,
		model: string,
	): Promise<void> {
		const messagesNow = host.messages();
		const idx = messagesNow.findIndex((m) => m.id === msg.id);
		if (idx <= 0) return;
		const userMsg = messagesNow[idx - 1];
		if (!userMsg || userMsg.role !== "user") return;

		// Remove the error message, then re-send with suggested
		// provider/model.
		host.allMessages.set(
			host.allMessages.get().filter((m) => m.id !== msg.id),
		);
		host.activeLeafId.set(host.computeLatestLeaf(host.allMessages.get()));

		// Temporarily override selected model for this send. Restore
		// after `handleSend` completes regardless of outcome — the user's
		// current pick should survive a failed fallback. We snapshot the
		// previous value BEFORE swapping so a thrown error in handleSend
		// (caught internally — never propagates here, but defensive)
		// doesn't leak the temporary pick.
		const prevModel = host.selectedModel.get();
		host.selectedModel.set({ provider, model });
		await handleSend(userMsg.content);
		host.selectedModel.set(prevModel);
	}

	// ── Sub-conversation handlers ─────────────────────────────────────

	async function handleSubConvoSend(text: string): Promise<void> {
		const active = subConversationStore.activeSubConversation;
		if (!active) return;
		subConversationStore.addMessage({
			id: `user-${Date.now()}`,
			role: "user",
			content: text,
			createdAt: new Date(),
		});
		try {
			subConversationStore.setStreaming(true);
			const result = await sendMessage(active.id, {
				content: text,
				parentMessageId: undefined,
			});
			// Sub-conversations don't fire EZ actions (the spawn path
			// doesn't go through the messages POST handler that
			// handles tokens). Narrow `runId | null` defensively.
			if (result.runId === null) {
				subConversationStore.setStreaming(false);
				return;
			}
			startStreaming(result.runId, active.id);
		} catch (err) {
			console.error("Sub-convo send failed:", err);
			subConversationStore.setStreaming(false);
		}
	}

	async function handleSubConvoReturn(): Promise<void> {
		const msgs = subConversationStore.endSubConversation();
		// Insert last agent message as summary in parent conversation.
		const lastAgentMsg = [...msgs]
			.reverse()
			.find((m) => m.role === "assistant");
		const convId = host.convId();
		if (lastAgentMsg && convId) {
			try {
				await sendMessage(convId, {
					content: `[Sub-conversation summary]: ${lastAgentMsg.content}`,
					parentMessageId: host.activeLeafId.get() ?? undefined,
				});
				await host.loadMessages();
			} catch (err) {
				console.error(
					"Failed to insert sub-convo summary:",
					err,
				);
			}
		}
	}

	async function startSubConvo(
		agentMention: { name: string },
		parentMessageId: string,
	): Promise<void> {
		// One sub-conversation at a time — matches the original page guard.
		if (subConversationStore.isInSubConversation) return;
		const convId = host.convId();
		const projectId = host.projectId();

		try {
			const subConv = await createSubConversation(convId, {
				parentMessageId,
				agentConfigId: "", // resolved server-side by agent name
				title: `Sub-conversation with ${agentMention.name}`,
				projectId,
			});
			const record: SubConvoRecord = {
				id: subConv.id,
				agentName: agentMention.name,
				agentConfigId: subConv.agentConfigId ?? "",
				parentMessageId,
			};
			host.subConversations.set([
				...host.subConversations.get(),
				record,
			]);
			subConversationStore.startSubConversation({
				id: subConv.id,
				agentConfigId: record.agentConfigId,
				agentName: agentMention.name,
				parentConversationId: convId,
				parentMessageId,
			});
		} catch (err) {
			console.error("Failed to start sub-conversation:", err);
		}
	}

	return {
		handleSend,
		handleEditConfirm,
		handleRegenerate,
		handleRerun,
		handleBranchNavigate,
		handleSaveMemory,
		handleRetry,
		handleFallback,
		handleSubConvoSend,
		handleSubConvoReturn,
		startSubConvo,
	};
}

