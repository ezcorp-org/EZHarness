<script lang="ts">
	/**
	 * SubstackReviewCard — the review queue for the `substack-engagement`
	 * extension's `open_review_queue` tool (`cardType: "substack-review"`).
	 *
	 * Visual model: `LessonsTab.svelte` — one card per queued draft showing
	 * the kind, the source context, an editable `draft_body` textarea, and
	 * Approve & Send / Edit / Reject actions. Delete/Reject uses inline
	 * click-to-confirm with a 3s timeout (NO `window.confirm`), matching the
	 * LessonsTab/KnowledgeBaseTab convention.
	 *
	 * Actions invoke the extension's own tools via `/api/tool-invoke`
	 * (`approve_item`, `edit_item`, `reject_item`, `send_approved`) — the
	 * same host endpoint DesignCanvasCard uses for its apply round-trip.
	 * Open question 2 resolution (documented in the Phase 4 commit): the
	 * card drives the tools directly rather than the createCanvas event
	 * path. Both reach the same subprocess handlers; tool-invoke gives the
	 * card a synchronous result it can reflect in the row's status, and
	 * keeps the example free of a bundled-grant requirement.
	 *
	 * Svelte 5 runes (`$state` / `$derived` / `$effect`).
	 */

	import type { ToolCallState } from "$lib/stores.svelte.js";

	type Kind = "reply" | "welcome-dm" | "note-comment";
	type Status = "pending" | "approved" | "rejected" | "sent" | "failed";

	interface QueueItem {
		id: string;
		kind: Kind;
		status: Status;
		target_ref: string;
		context: string;
		draft_body: string;
		due_at: number | null;
		sequence_step?: number;
		error?: string;
	}

	let {
		toolCall,
		conversationId = "",
	}: { toolCall: ToolCallState; conversationId?: string } = $props();

	const EXTENSION = "substack-engagement";

	// ── Parse the queue payload from the tool result ────────────────
	function parsePayload(output: unknown): QueueItem[] {
		if (output == null) return [];
		let raw: unknown = output;
		// The host serializes the tool result's text content; output may be
		// the JSON string or an already-parsed object / {content:[{text}]}.
		if (typeof output === "object" && "content" in (output as object)) {
			const content = (output as { content?: unknown }).content;
			if (Array.isArray(content)) {
				const text = content
					.map((c) => (c as { text?: string }).text ?? "")
					.join("");
				raw = text;
			}
		}
		try {
			const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
			const o = obj as { pending?: QueueItem[]; approved?: QueueItem[] };
			return [...(o.pending ?? []), ...(o.approved ?? [])];
		} catch {
			return [];
		}
	}

	// Items are local state so edits + status flips reflect immediately.
	let items = $state<QueueItem[]>([]);
	let loadError = $state<string | null>(null);

	$effect(() => {
		// Re-derive whenever the tool output changes (e.g. a refresh).
		try {
			items = parsePayload(toolCall.output);
			loadError = null;
		} catch (err) {
			loadError = err instanceof Error ? err.message : "Failed to read queue";
		}
		return () => {
			if (confirmTimeout) clearTimeout(confirmTimeout);
		};
	});

	// Rows actioned in THIS card session stay visible so the user sees the
	// outcome (sent / failed / deferred), rather than the row vanishing.
	let touchedIds = $state<Set<string>>(new Set());

	let isLoading = $derived(toolCall.status === "running");
	let toolErrored = $derived(toolCall.status === "error");
	let pending = $derived(items.filter((i) => i.status === "pending"));
	let approved = $derived(items.filter((i) => i.status === "approved"));
	let visibleItems = $derived(
		items.filter(
			(i) => i.status === "pending" || i.status === "approved" || touchedIds.has(i.id),
		),
	);

	// Per-row busy + edit + confirm state, keyed by item id.
	let busyId = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let editValues = $state<Record<string, string>>({});
	let confirmingReject = $state<string | null>(null);
	let confirmTimeout: ReturnType<typeof setTimeout> | undefined;

	function bodyOf(item: QueueItem): string {
		return editValues[item.id] ?? item.draft_body;
	}

	function isDirty(item: QueueItem): boolean {
		const edited = editValues[item.id];
		return edited !== undefined && edited !== item.draft_body;
	}

	function kindLabel(kind: Kind): string {
		switch (kind) {
			case "reply":
				return "Comment reply";
			case "welcome-dm":
				return "Welcome DM";
			case "note-comment":
				return "Note comment";
		}
	}

	function kindBadgeClass(kind: Kind): string {
		switch (kind) {
			case "reply":
				return "bg-blue-800/40 text-blue-200";
			case "welcome-dm":
				return "bg-emerald-800/40 text-emerald-200";
			case "note-comment":
				return "bg-amber-800/40 text-amber-200";
		}
	}

	// ── Tool invocation ─────────────────────────────────────────────
	async function invokeTool(
		toolName: string,
		input: Record<string, unknown>,
	): Promise<{ ok: boolean; output?: string; error?: string }> {
		const invocationId =
			globalThis.crypto?.randomUUID?.() ??
			Math.random().toString(36).slice(2) + Date.now().toString(36);
		try {
			const res = await fetch("/api/tool-invoke", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					extensionName: EXTENSION,
					toolName,
					input,
					conversationId,
					invocationId,
				}),
			});
			const data = (await res.json().catch(() => ({}))) as {
				success?: boolean;
				output?: string;
				error?: string;
			};
			if (!res.ok || data.success === false) {
				return { ok: false, error: data.error ?? `Request failed (${res.status})` };
			}
			return { ok: true, output: data.output };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	function setStatus(id: string, status: Status): void {
		items = items.map((i) => (i.id === id ? { ...i, status } : i));
		// Keep the actioned row on screen so the outcome is visible even
		// when the new status (sent/failed/rejected) would otherwise filter
		// it out of the pending/approved view.
		touchedIds = new Set(touchedIds).add(id);
	}

	async function saveEdit(item: QueueItem): Promise<void> {
		const body = bodyOf(item).trim();
		if (!body || busyId) return;
		busyId = item.id;
		actionError = null;
		const res = await invokeTool("edit_item", { id: item.id, draft_body: body });
		busyId = null;
		if (!res.ok) {
			actionError = res.error ?? "Edit failed";
			return;
		}
		items = items.map((i) => (i.id === item.id ? { ...i, draft_body: body } : i));
		delete editValues[item.id];
		editValues = { ...editValues };
	}

	async function approveAndSend(item: QueueItem): Promise<void> {
		if (busyId) return;
		busyId = item.id;
		actionError = null;
		// Persist any pending edit first so the sent body matches the textarea.
		if (isDirty(item)) {
			const edit = await invokeTool("edit_item", {
				id: item.id,
				draft_body: bodyOf(item).trim(),
			});
			if (!edit.ok) {
				busyId = null;
				actionError = edit.error ?? "Edit failed";
				return;
			}
			delete editValues[item.id];
			editValues = { ...editValues };
		}
		const approveRes = await invokeTool("approve_item", { id: item.id });
		if (!approveRes.ok) {
			busyId = null;
			actionError = approveRes.error ?? "Approve failed";
			return;
		}
		setStatus(item.id, "approved");
		const sendRes = await invokeTool("send_approved", { id: item.id });
		busyId = null;
		if (!sendRes.ok) {
			actionError = sendRes.error ?? "Send failed";
			setStatus(item.id, "failed");
			return;
		}
		// Parse the send result to reflect sent vs deferred (note pacing).
		let deferred = false;
		try {
			const parsed = JSON.parse(sendRes.output ?? "{}") as { deferred?: number };
			deferred = (parsed.deferred ?? 0) > 0;
		} catch {
			/* tolerate non-JSON */
		}
		if (deferred) {
			// Pacing held it back — it stays approved, will send later.
			setStatus(item.id, "approved");
			actionError = "Send deferred by the pacing guard — it will send when the window opens.";
		} else {
			setStatus(item.id, "sent");
		}
	}

	function handleRejectClick(item: QueueItem): void {
		if (confirmingReject === item.id) {
			void doReject(item);
		} else {
			confirmingReject = item.id;
			clearTimeout(confirmTimeout);
			confirmTimeout = setTimeout(() => {
				confirmingReject = null;
			}, 3000);
		}
	}

	async function doReject(item: QueueItem): Promise<void> {
		confirmingReject = null;
		if (busyId) return;
		busyId = item.id;
		actionError = null;
		const res = await invokeTool("reject_item", { id: item.id });
		busyId = null;
		if (!res.ok) {
			actionError = res.error ?? "Reject failed";
			return;
		}
		setStatus(item.id, "rejected");
	}
</script>

<div
	class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden"
	data-testid="substack-review-card"
>
	<!-- Header -->
	<div
		class="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]"
	>
		<span class="text-xs font-medium text-[var(--color-text-secondary)]">Substack review queue</span>
		<span class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]" data-testid="review-counts">
			{pending.length} pending · {approved.length} approved
		</span>
	</div>

	<div class="px-3 py-3">
		{#if isLoading}
			<div class="text-sm text-[var(--color-text-muted)]" data-testid="review-loading">
				Loading queue…
			</div>
		{:else if toolErrored}
			<div
				class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300"
				role="alert"
				data-testid="review-error"
			>
				{toolCall.error ?? loadError ?? "Failed to load the review queue."}
			</div>
		{:else if visibleItems.length === 0}
			<div
				class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 text-center text-sm text-[var(--color-text-secondary)]"
				data-testid="review-empty"
			>
				No drafts to review. Run a scan (comments, subscribers, or notes) to
				queue some — nothing sends until you approve it.
			</div>
		{:else}
			{#if actionError}
				<div
					class="mb-3 rounded-md border border-[var(--color-warning,#f59e0b)]/50 bg-[var(--color-warning,#f59e0b)]/10 px-3 py-2 text-xs text-[var(--color-text-secondary)]"
					role="alert"
					data-testid="review-action-error"
				>
					{actionError}
				</div>
			{/if}
			<ul class="space-y-4" data-testid="review-list">
				{#each visibleItems as item (item.id)}
					<li
						class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
						data-testid="review-row"
						data-item-id={item.id}
						data-kind={item.kind}
						data-status={item.status}
					>
						<div class="flex items-center gap-2">
							<span
								class="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {kindBadgeClass(item.kind)}"
								data-testid="review-kind"
							>
								{kindLabel(item.kind)}
							</span>
							<span
								class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
								data-testid="review-status"
							>
								{item.status}
							</span>
						</div>

						<!-- Source context the draft responds to -->
						<div
							class="mt-2 whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1.5 text-xs text-[var(--color-text-muted)]"
							data-testid="review-context"
						>
							{item.context}
						</div>

						<!-- Editable draft body -->
						<textarea
							class="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-blue-500 focus:outline-none disabled:opacity-50"
							rows={3}
							data-testid="review-body"
							disabled={busyId === item.id || item.status === "sent"}
							value={bodyOf(item)}
							oninput={(e) => {
								editValues = {
									...editValues,
									[item.id]: (e.currentTarget as HTMLTextAreaElement).value,
								};
							}}
						></textarea>

						{#if item.error}
							<div class="mt-1 text-xs text-red-300" data-testid="review-row-error">
								Last send error: {item.error}
							</div>
						{/if}

						<div class="mt-2 flex items-center justify-end gap-2" data-testid="review-actions">
							{#if isDirty(item)}
								<button
									type="button"
									class="rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
									disabled={busyId === item.id}
									data-testid="review-save"
									onclick={() => saveEdit(item)}
								>
									Save edit
								</button>
							{/if}
							<button
								type="button"
								class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
								disabled={busyId === item.id || item.status === "sent" || !bodyOf(item).trim()}
								data-testid="review-approve-send"
								onclick={() => approveAndSend(item)}
							>
								{busyId === item.id ? "Working…" : "Approve & Send"}
							</button>
							<button
								type="button"
								class="rounded px-2 py-1 text-xs transition-colors
									{confirmingReject === item.id
										? 'bg-red-700 text-white'
										: 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-red-400'}"
								disabled={busyId === item.id || item.status === "sent"}
								data-testid="review-reject"
								onclick={() => handleRejectClick(item)}
							>
								{confirmingReject === item.id ? "Confirm?" : "Reject"}
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
