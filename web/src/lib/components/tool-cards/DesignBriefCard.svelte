<script lang="ts">
	// Inline tool-card for the `clarify-brief` tool from the
	// `claude-design` bundled extension. Renders a form built from the
	// agent-supplied `fields` descriptor array; submits the structured
	// answer to the generic events route which the extension subscribes
	// to. Mirrors `AskUserQuestionCard.svelte`'s state machine
	// (running / sending / answered / error) but supports multiple
	// fields of three kinds: text / select / multi-select.
	//
	// No iframe — this is NOT an `ExtensionIframeCard`-based card.

	import { untrack } from "svelte";
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { userFetch } from "$lib/utils/fetch-policy.js";
	import { buildEventUrl } from "./iframe-card-logic.js";

	type Field = {
		key: string;
		label: string;
		kind: "text" | "select" | "multi-select";
		options?: string[];
		placeholder?: string;
		required?: boolean;
	};

	let {
		toolCall,
		conversationId,
	}: {
		toolCall: ToolCallState;
		conversationId?: string;
	} = $props();

	// ── Parse input ─────────────────────────────────────────────────
	let input = $derived(
		toolCall.input as { fields?: Field[]; intro?: string } | undefined,
	);
	let fields = $derived<Field[]>(
		Array.isArray(input?.fields) ? (input!.fields as Field[]) : [],
	);
	let intro = $derived(typeof input?.intro === "string" ? input.intro : undefined);

	// ── Form state ──────────────────────────────────────────────────
	// Keyed by field.key. String for text/select, string[] for multi-select.
	let values = $state<Record<string, string | string[]>>({});

	// ── State machine ──────────────────────────────────────────────
	let phase = $state<"running" | "sending" | "answered" | "error">(
		untrack(() => (toolCall.status === "complete" ? "answered" : "running")),
	);
	let errorMessage = $state<string | null>(null);

	// ── Output rendering (when complete) ────────────────────────────
	// Tool result envelope: `{ content: [{ type: "text", text: "<json>" }] }`.
	// The text is a JSON-serialized `Record<string, string|string[]>`.
	let answeredAnswer = $derived.by((): Record<string, string | string[]> | null => {
		if (toolCall.status !== "complete") return null;
		const out = toolCall.output;
		if (out == null) return null;
		const tryParse = (s: string): Record<string, string | string[]> | null => {
			try {
				const parsed = JSON.parse(s);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return parsed as Record<string, string | string[]>;
				}
				return null;
			} catch {
				return null;
			}
		};
		if (typeof out === "string") return tryParse(out);
		if (typeof out === "object" && "content" in out) {
			const content = (out as { content: unknown }).content;
			if (Array.isArray(content)) {
				const text = content.find(
					(c): c is { type: "text"; text: string } =>
						typeof c === "object" &&
						c !== null &&
						(c as { type?: unknown }).type === "text" &&
						typeof (c as { text?: unknown }).text === "string",
				)?.text;
				if (typeof text === "string") return tryParse(text);
			}
		}
		// Already-parsed object form.
		if (typeof out === "object" && !Array.isArray(out)) {
			return out as Record<string, string | string[]>;
		}
		return null;
	});

	// What to show in the summary block — prefer the parsed
	// server-side answer (authoritative); fall back to local `values`
	// if we just submitted but `complete` hasn't arrived yet.
	let summaryEntries = $derived.by((): Array<[string, string]> => {
		const src: Record<string, string | string[]> | null =
			answeredAnswer ?? (phase === "answered" ? values : null);
		if (!src) return [];
		return Object.entries(src).map(([k, v]) => [
			k,
			Array.isArray(v) ? v.join(", ") : String(v),
		]);
	});

	// ── Submit handler ─────────────────────────────────────────────
	async function submit(): Promise<void> {
		if (!toolCall.id) {
			errorMessage = "Missing tool-call id — cannot submit.";
			phase = "error";
			return;
		}
		if (!conversationId) {
			errorMessage = "Missing conversation id — cannot submit.";
			phase = "error";
			return;
		}
		// Required-field check.
		for (const f of fields) {
			if (!f.required) continue;
			const v = values[f.key];
			const empty =
				v == null ||
				(Array.isArray(v)
					? v.length === 0
					: typeof v === "string"
						? v.trim().length === 0
						: true);
			if (empty) {
				errorMessage = `Required field missing: ${f.label}`;
				phase = "error";
				return;
			}
		}
		phase = "sending";
		errorMessage = null;
		try {
			const res = await userFetch(buildEventUrl("claude-design", "brief-answer"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					toolCallId: toolCall.id,
					conversationId,
					answer: values,
				}),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as
					| { error?: string }
					| null;
				throw new Error(data?.error ?? `HTTP ${res.status}`);
			}
			phase = "answered";
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			phase = "error";
		}
	}

	function toggleMulti(key: string, option: string): void {
		const cur = (values[key] as string[] | undefined) ?? [];
		if (cur.includes(option)) {
			values[key] = cur.filter((o) => o !== option);
		} else {
			values[key] = [...cur, option];
		}
	}

	function retry(): void {
		errorMessage = null;
		phase = "running";
	}

	function handleSubmit(e: Event): void {
		e.preventDefault();
		void submit();
	}
</script>

<div
	class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden"
	data-testid="design-brief-card"
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
				d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
			/>
		</svg>
		<span class="text-xs font-medium text-[var(--color-text-secondary)]"
			>{toolCall.toolName}</span
		>
		{#if toolCall.status === "complete" || phase === "answered"}
			<span class="text-[10px] uppercase tracking-wider text-green-400">answered</span>
		{:else if phase === "sending"}
			<span class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]"
				>sending…</span
			>
		{:else if phase === "error"}
			<span class="text-[10px] uppercase tracking-wider text-red-400">error</span>
		{:else}
			<span class="text-[10px] uppercase tracking-wider text-amber-400"
				>awaiting answer</span
			>
		{/if}
	</div>

	<!-- Body -->
	<div class="px-3 py-3">
		{#if intro}
			<p
				class="mb-3 text-sm text-[var(--color-text-primary)] whitespace-pre-wrap"
				data-testid="design-brief-intro"
			>
				{intro}
			</p>
		{/if}

		{#if toolCall.status === "complete" || phase === "answered"}
			<!-- Summary block -->
			<div
				class="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2"
				data-testid="design-brief-summary"
			>
				<div class="text-[10px] uppercase tracking-wider text-green-400">
					Submitted
				</div>
				<dl class="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
					{#each summaryEntries as [k, v] (k)}
						<dt class="font-medium text-[var(--color-text-secondary)]">{k}:</dt>
						<dd class="text-[var(--color-text-primary)] whitespace-pre-wrap">{v}</dd>
					{/each}
				</dl>
			</div>
		{:else if phase === "error"}
			<div
				class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300"
				role="alert"
				data-testid="design-brief-error"
			>
				<div>{errorMessage ?? "Unknown error"}</div>
				{#if toolCall.id && conversationId}
					<button
						type="button"
						class="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-200 hover:bg-red-500/20"
						onclick={retry}
						data-testid="design-brief-retry"
					>
						Retry
					</button>
				{/if}
			</div>
		{:else}
			<form
				onsubmit={handleSubmit}
				class="flex flex-col gap-3"
				data-testid="design-brief-form"
			>
				{#each fields as f (f.key)}
					<label class="flex flex-col gap-1">
						<span class="text-xs text-[var(--color-text-muted)]">
							{f.label}{#if f.required}<span class="text-red-400"> *</span>{/if}
						</span>

						{#if f.kind === "text"}
							<textarea
								bind:value={values[f.key] as string}
								placeholder={f.placeholder ?? ""}
								rows={3}
								disabled={phase === "sending" || !toolCall.id}
								class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-amber-500 focus:outline-none disabled:opacity-50"
								data-testid={`design-brief-text-${f.key}`}
							></textarea>
						{:else if f.kind === "select"}
							<select
								bind:value={values[f.key] as string}
								disabled={phase === "sending" || !toolCall.id}
								class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-amber-500 focus:outline-none disabled:opacity-50"
								data-testid={`design-brief-select-${f.key}`}
							>
								<option value="">— choose —</option>
								{#each f.options ?? [] as opt (opt)}
									<option value={opt}>{opt}</option>
								{/each}
							</select>
						{:else if f.kind === "multi-select"}
							<div
								role="group"
								aria-label={f.label}
								class="flex flex-wrap gap-2"
								data-testid={`design-brief-multi-${f.key}`}
							>
								{#each f.options ?? [] as opt (opt)}
									<label
										class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2.5 py-1 text-sm text-[var(--color-text-primary)] cursor-pointer hover:border-amber-500"
									>
										<input
											type="checkbox"
											checked={((values[f.key] as string[] | undefined) ?? []).includes(
												opt,
											)}
											onchange={() => toggleMulti(f.key, opt)}
											disabled={phase === "sending" || !toolCall.id}
										/>
										{opt}
									</label>
								{/each}
							</div>
						{/if}
					</label>
				{/each}

				<div class="flex justify-end">
					<button
						type="submit"
						disabled={phase === "sending" || !toolCall.id}
						class="rounded-md bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
						data-testid="design-brief-submit"
					>
						{phase === "sending" ? "Sending…" : "Submit"}
					</button>
				</div>
			</form>
		{/if}

		{#if !toolCall.id}
			<div
				class="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300"
				role="alert"
				data-testid="design-brief-missing-id"
			>
				Cannot submit: tool-call id missing.
			</div>
		{/if}
	</div>
</div>
