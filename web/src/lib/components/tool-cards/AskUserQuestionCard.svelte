<script lang="ts">
	// Inline tool-card for the `ask_user_question` tool from the
	// `ask-user` bundled extension. Renders the question text plus
	// either a button-per-option grid (when `options` is non-empty)
	// or a free-text textarea. Click → POST /api/ask-user/answer with
	// `{ toolCallId, answer }`. The server emits `ask-user:answer` on
	// the host bus; the extension's subscription handler resolves the
	// pending-answer gate and the LLM's tool-call returns the answer.
	//
	// Defensive states:
	//  - `running` + no submit yet: show buttons / textarea (active).
	//  - `running` + just submitted: disable controls, show "Sending…"
	//    spinner. The card stays in this state until `tool:complete`
	//    arrives (microseconds usually).
	//  - `complete`: render "Answered: <answer>" summary.
	//  - `error`: render the error text.
	//  - missing `toolCall.id`: render an inert error block (the
	//    server-side fix to the streaming-tool-call upsert in
	//    stores.svelte.ts:699 ensures id is populated, but the client
	//    is defensive in case of older server builds).

	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { userFetch } from "$lib/utils/fetch-policy.js";

	let { toolCall }: { toolCall: ToolCallState } = $props();

	// ── Parse input ─────────────────────────────────────────────────
	let parsedInput = $derived.by((): { question: string; options: string[] } => {
		const inp = toolCall.input;
		if (!inp || typeof inp !== "object") return { question: "", options: [] };
		const obj = inp as Record<string, unknown>;
		const question = typeof obj.question === "string" ? obj.question : "";
		const opts = Array.isArray(obj.options)
			? obj.options.filter((o): o is string => typeof o === "string")
			: [];
		return { question, options: opts };
	});

	let hasOptions = $derived(parsedInput.options.length > 0);

	// ── Local state ─────────────────────────────────────────────────
	let textValue = $state("");
	let submitting = $state(false);
	let submitError = $state<string | null>(null);

	// ── Output rendering ────────────────────────────────────────────
	let answeredText = $derived.by((): string | undefined => {
		if (toolCall.status !== "complete") return undefined;
		const out = toolCall.output;
		if (out == null) return undefined;
		// Tool result shape: `{ content: [{ type: "text", text: "..." }] }`
		if (typeof out === "object" && "content" in out) {
			const content = (out as { content: unknown }).content;
			if (Array.isArray(content)) {
				const texts = content
					.filter(
						(c): c is { type: "text"; text: string } =>
							typeof c === "object" &&
							c !== null &&
							(c as { type?: unknown }).type === "text" &&
							typeof (c as { text?: unknown }).text === "string",
					)
					.map((c) => c.text);
				if (texts.length > 0) return texts.join("\n");
			}
		}
		return typeof out === "string" ? out : JSON.stringify(out);
	});

	// ── Submit handler ─────────────────────────────────────────────
	async function submitAnswer(answer: string): Promise<void> {
		const trimmed = answer.trim();
		if (!trimmed || submitting) return;
		const id = toolCall.id;
		if (!id) {
			submitError = "Missing tool-call id — cannot send answer.";
			return;
		}
		submitting = true;
		submitError = null;
		try {
			const res = await userFetch("/api/ask-user/answer", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ toolCallId: id, answer: trimmed }),
			});
			if (!res.ok) {
				submitError = `Server returned ${res.status}`;
				submitting = false;
			}
			// Successful POST: keep `submitting = true` until tool:complete
			// arrives and the card's status flips. If something goes wrong
			// upstream, the watchdog will eventually emit tool:error.
		} catch (err) {
			submitError = err instanceof Error ? err.message : String(err);
			submitting = false;
		}
	}

	function handleOptionClick(option: string): void {
		void submitAnswer(option);
	}

	function handleSubmitText(e: Event): void {
		e.preventDefault();
		void submitAnswer(textValue);
	}

	function handleTextareaKeydown(e: KeyboardEvent): void {
		// Enter submits, Shift+Enter newlines (textarea-of-record convention).
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void submitAnswer(textValue);
		}
	}
</script>

<div
	class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden"
	data-testid="ask-user-question-card"
>
	<!-- Header -->
	<div
		class="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]"
	>
		<svg
			class="h-3.5 w-3.5 shrink-0 text-amber-400"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
			/>
		</svg>
		<span class="text-xs font-medium text-[var(--color-text-secondary)]">{toolCall.toolName}</span>
		{#if toolCall.status === "running" && !submitting}
			<span class="text-[10px] uppercase tracking-wider text-amber-400">awaiting answer</span>
		{:else if submitting}
			<span class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">sending…</span>
		{:else if toolCall.status === "complete"}
			<span class="text-[10px] uppercase tracking-wider text-green-400">answered</span>
		{:else if toolCall.status === "error"}
			<span class="text-[10px] uppercase tracking-wider text-red-400">error</span>
		{/if}
	</div>

	<!-- Body -->
	<div class="px-3 py-3">
		{#if parsedInput.question}
			<p class="mb-3 text-sm text-[var(--color-text-primary)] whitespace-pre-wrap">
				{parsedInput.question}
			</p>
		{/if}

		{#if toolCall.status === "complete"}
			<div class="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2">
				<div class="text-[10px] uppercase tracking-wider text-green-400">Answered</div>
				<div
					class="mt-1 text-sm text-[var(--color-text-primary)] whitespace-pre-wrap"
					data-testid="ask-user-answered-text"
				>
					{answeredText ?? ""}
				</div>
			</div>
		{:else if toolCall.status === "error"}
			<div class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
				{toolCall.error ?? "Unknown error"}
			</div>
		{:else if hasOptions}
			<div
				class="flex flex-wrap gap-2"
				role="group"
				aria-label="Answer options"
				data-testid="ask-user-options"
			>
				{#each parsedInput.options as option (option)}
					<button
						type="button"
						class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:border-amber-500 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
						disabled={submitting || !toolCall.id}
						onclick={() => handleOptionClick(option)}
					>
						{option}
					</button>
				{/each}
			</div>
		{:else}
			<form
				onsubmit={handleSubmitText}
				class="flex flex-col gap-2"
				data-testid="ask-user-text-form"
			>
				<textarea
					bind:value={textValue}
					onkeydown={handleTextareaKeydown}
					placeholder="Type your answer… (Enter to send, Shift+Enter for newline)"
					rows={3}
					disabled={submitting || !toolCall.id}
					class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-amber-500 focus:outline-none disabled:opacity-50"
				></textarea>
				<div class="flex justify-end">
					<button
						type="submit"
						disabled={submitting || !textValue.trim() || !toolCall.id}
						class="rounded-md bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
					>
						{submitting ? "Sending…" : "Send"}
					</button>
				</div>
			</form>
		{/if}

		{#if submitError}
			<div
				class="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300"
				role="alert"
				data-testid="ask-user-submit-error"
			>
				{submitError}
			</div>
		{/if}

		{#if !toolCall.id}
			<div
				class="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300"
				role="alert"
				data-testid="ask-user-missing-id"
			>
				Cannot send answer: tool-call id missing.
			</div>
		{/if}
	</div>
</div>
