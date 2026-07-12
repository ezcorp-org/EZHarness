<script lang="ts">
	import { onMount, untrack } from "svelte";

	/**
	 * CommandForm — full-frontmatter editor for a per-user slash command.
	 *
	 * Modes:
	 *   - `mode = "create"`: name editable + slug-validated; submitted
	 *     payload includes `name`.
	 *   - `mode = "edit"`: name disabled (rename deferred to v1.5);
	 *     submitted payload omits `name` so PATCH /api/user-commands/[name]
	 *     ignores it server-side.
	 *
	 * Validation lives in this component so the page-level handlers stay
	 * thin. The 400 from the API is the safety net.
	 */

	export interface CommandFormInitial {
		name?: string;
		description?: string;
		body?: string;
		frontmatter?: {
			"argument-hint"?: string;
			agent?: string;
			model?: string;
		};
	}

	export interface CommandFormPayload {
		name?: string;
		description: string;
		body: string;
		frontmatter: Record<string, string>;
	}

	const SLUG_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;
	const BODY_MAX_BYTES = 64 * 1024;

	let {
		initial = {},
		mode = "create",
		submitting = false,
		onsubmit,
		oncancel,
	}: {
		initial?: CommandFormInitial;
		mode?: "create" | "edit";
		submitting?: boolean;
		onsubmit: (payload: CommandFormPayload) => void | Promise<void>;
		oncancel?: () => void;
	} = $props();

	// One-shot initialization from the `initial` prop. `untrack` makes
	// the intent explicit and silences Svelte 5's
	// "state_referenced_locally" warning — once the form is mounted,
	// updates to `initial` from the parent should NOT clobber the
	// user's in-progress edits (the edit page already loads `initial`
	// before rendering the form, so the prop is stable after mount).
	let name = $state(untrack(() => initial.name ?? ""));
	let description = $state(untrack(() => initial.description ?? ""));
	let argumentHint = $state(untrack(() => initial.frontmatter?.["argument-hint"] ?? ""));
	let agent = $state(untrack(() => initial.frontmatter?.agent ?? ""));
	let model = $state(untrack(() => initial.frontmatter?.model ?? ""));
	let body = $state(untrack(() => initial.body ?? ""));

	let nameError = $state<string | null>(null);
	let bodyError = $state<string | null>(null);

	// Live char counter (byte-counted via TextEncoder so multi-byte
	// chars match the server's cap). Computed lazily per keystroke.
	let bodyBytes = $derived(new TextEncoder().encode(body).length);
	let bodyOverLimit = $derived(bodyBytes > BODY_MAX_BYTES);

	let modelOptions = $state<string[]>([]);
	onMount(async () => {
		// Best-effort populate: if /api/models fails (no keys / OAuth
		// not connected), fall through to a plain text input. The
		// model field is advisory only per spec — never required.
		try {
			const res = await fetch("/api/models");
			if (!res.ok) return;
			const data = (await res.json()) as { model?: string }[];
			modelOptions = Array.from(new Set(data.map((m) => m.model).filter((m): m is string => typeof m === "string"))).sort();
		} catch {
			/* swallow — advisory only */
		}
	});

	function validate(): boolean {
		nameError = null;
		bodyError = null;

		if (mode === "create") {
			if (!name) {
				nameError = "Name is required";
			} else if (!SLUG_PATTERN.test(name)) {
				nameError = "Name must be lowercase alphanumeric with optional - or _, max 64 chars";
			}
		}

		if (bodyOverLimit) {
			bodyError = `Body exceeds 64 KB (currently ${bodyBytes} bytes)`;
		}

		return !nameError && !bodyError;
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (!validate()) return;

		// Build a flat frontmatter object; drop empty strings so the
		// server-side filter sees only meaningful values (also keeps
		// the persisted shape compact).
		const frontmatter: Record<string, string> = {};
		if (argumentHint) frontmatter["argument-hint"] = argumentHint;
		if (agent) frontmatter.agent = agent;
		if (model) frontmatter.model = model;

		const payload: CommandFormPayload = {
			description,
			body,
			frontmatter,
		};
		if (mode === "create") payload.name = name;

		await onsubmit(payload);
	}
</script>

<form onsubmit={handleSubmit} class="space-y-4" data-testid="command-form" novalidate>
	<div>
		<label for="cmd-name" class="block text-sm font-medium text-[var(--color-text-primary)]">Name</label>
		<input
			id="cmd-name"
			type="text"
			bind:value={name}
			disabled={mode === "edit"}
			required={mode === "create"}
			maxlength="64"
			autocomplete="off"
			data-testid="command-form-name"
			class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
			placeholder="my-review"
		/>
		{#if mode === "edit"}
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">Rename is not supported yet — delete + recreate to change the name.</p>
		{:else}
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">
				Used as <code>/{name || "name"}</code>. Lowercase letters, digits, <code>-</code>, <code>_</code>; max 64 chars.
			</p>
		{/if}
		{#if nameError}
			<p class="mt-1 text-sm text-red-400" data-testid="command-form-name-error">{nameError}</p>
		{/if}
	</div>

	<div>
		<label for="cmd-desc" class="block text-sm font-medium text-[var(--color-text-primary)]">Description</label>
		<input
			id="cmd-desc"
			type="text"
			bind:value={description}
			maxlength="500"
			autocomplete="off"
			data-testid="command-form-description"
			class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-blue-500 focus:outline-none"
			placeholder="Short summary shown in the slash-command popover"
		/>
	</div>

	<div>
		<label for="cmd-arghint" class="block text-sm font-medium text-[var(--color-text-primary)]">Argument hint
			<span class="text-[var(--color-text-muted)]">(optional)</span>
		</label>
		<input
			id="cmd-arghint"
			type="text"
			bind:value={argumentHint}
			maxlength="200"
			autocomplete="off"
			data-testid="command-form-argument-hint"
			class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-blue-500 focus:outline-none"
			placeholder="e.g. <file-path>"
		/>
		<p class="mt-1 text-xs text-[var(--color-text-muted)]">Placeholder rendered next to the command in the popover.</p>
	</div>

	<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
		<div>
			<label for="cmd-agent" class="block text-sm font-medium text-[var(--color-text-primary)]">Agent
				<span class="text-[var(--color-text-muted)]">(optional)</span>
			</label>
			<input
				id="cmd-agent"
				type="text"
				bind:value={agent}
				maxlength="100"
				autocomplete="off"
				data-testid="command-form-agent"
				class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-blue-500 focus:outline-none"
				placeholder="agent-name"
			/>
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">Routes the expanded prompt to this sub-agent.</p>
		</div>
		<div>
			<label for="cmd-model" class="block text-sm font-medium text-[var(--color-text-primary)]">Model
				<span class="text-[var(--color-text-muted)]">(optional, advisory)</span>
			</label>
			<input
				id="cmd-model"
				type="text"
				list="cmd-model-options"
				bind:value={model}
				maxlength="100"
				autocomplete="off"
				data-testid="command-form-model"
				class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-blue-500 focus:outline-none"
				placeholder="claude-sonnet-4-5"
			/>
			<datalist id="cmd-model-options">
				{#each modelOptions as opt}
					<option value={opt}></option>
				{/each}
			</datalist>
		</div>
	</div>

	<div>
		<label for="cmd-body" class="block text-sm font-medium text-[var(--color-text-primary)]">Body</label>
		<textarea
			id="cmd-body"
			bind:value={body}
			rows="14"
			required
			data-testid="command-form-body"
			class="mt-1 w-full rounded-md border {bodyOverLimit ? 'border-red-500' : 'border-[var(--color-border)]'} bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-[var(--color-text-primary)] focus:border-blue-500 focus:outline-none"
			placeholder={`Write the prompt body here. Use $ARGUMENTS for all args, or $1, $2, ... for positional ones.`}
		></textarea>
		<div class="mt-1 flex items-center justify-between text-xs">
			<p class="text-[var(--color-text-muted)]">
				Use <code>$ARGUMENTS</code> for the full argument string, or <code>$1</code>, <code>$2</code>, … for positional arguments.
			</p>
			<p
				class="{bodyOverLimit ? 'font-semibold text-red-400' : 'text-[var(--color-text-muted)]'}"
				data-testid="command-form-body-bytes"
			>
				{bodyBytes} / {BODY_MAX_BYTES} bytes
			</p>
		</div>
		{#if bodyError}
			<p class="mt-1 text-sm text-red-400" data-testid="command-form-body-error">{bodyError}</p>
		{/if}
	</div>

	<div class="flex flex-wrap gap-2 pt-2">
		<button
			type="submit"
			disabled={submitting || bodyOverLimit}
			data-testid="command-form-submit"
			class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
		>
			{#if submitting}
				Saving…
			{:else}
				Save
			{/if}
		</button>
		{#if oncancel}
			<button
				type="button"
				onclick={oncancel}
				class="rounded-md bg-[var(--color-surface-tertiary)] px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
				data-testid="command-form-cancel"
			>
				Cancel
			</button>
		{/if}
	</div>
</form>
