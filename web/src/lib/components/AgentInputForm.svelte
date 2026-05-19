<!--
  AgentInputForm — runs an agent, driven by an `InputSchema` from `$lib/api.js`.

  ── Why this does NOT delegate to SchemaForm ──
  An earlier slice flagged the duplicated primitive renderers and asked whether
  AgentInputForm should delegate the overlapping field types (text / number /
  boolean / select) to <SchemaForm/>. After auditing both schemas the answer
  is no: the two are surface-similar but semantically incompatible, and forcing
  a shared renderer would either bloat SchemaForm with branches that only one
  caller needs, or require an awkward per-call adapter that's larger than the
  duplicated markup it replaces. The blocking divergences:

    1. `select.options` shape — AgentInputForm uses `string[]`, SchemaForm uses
       `{ value, label }[]`. Different on-screen contract.
    2. `text` semantics — AgentInputForm renders a multi-line `<textarea rows=4>`
       (free-form agent prompts), SchemaForm renders a single-line
       `<input type="text">` with `minLength`/`maxLength`/`pattern` validation.
    3. Required fields — AgentInputForm has a `required` flag with a red
       asterisk and submit-blocking validation; SettingsField has no notion of
       required (settings always have a default).
    4. Submit/error UX — AgentInputForm owns a visible Run button, an inline
       error string, and clean-input filtering (empty optionals are stripped);
       SchemaForm is fully controlled with only a hidden submit affordance.
    5. Agent-only field types — `custom` (component fallback), `file-path`,
       and the plain single-line `string` variant don't exist in SettingsSchema.

  The redundant renderers stay local on purpose. If a future change unifies
  the schemas (e.g. add `required` + textarea variant to SettingsField, or
  normalise `select.options` to objects), revisit the delegation then.
-->

<script lang="ts">
	import type { InputSchema } from "$lib/api.js";
	import type { Component } from "svelte";
	import { inputClass } from "$lib/styles.js";
	import FilePicker from "./FilePicker.svelte";

	let {
		schema,
		onsubmit,
		submitting = false,
		defaults = {},
		projectVariables = {},
	}: {
		schema: InputSchema;
		onsubmit: (input: Record<string, unknown>) => void;
		submitting?: boolean;
		defaults?: Record<string, unknown>;
		projectVariables?: Record<string, unknown>;
	} = $props();

	function toTitleCase(key: string): string {
		return key
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/[_-]/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function inferSchema(vars: Record<string, unknown>, existing: InputSchema): InputSchema {
		const extra: InputSchema = {};
		for (const [key, value] of Object.entries(vars)) {
			if (key in existing) continue;
			const type = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
			extra[key] = { type, label: toTitleCase(key), default: value };
		}
		return extra;
	}

	let extraVarSchema = $derived(inferSchema(projectVariables, schema));

	function buildDefaults(s: InputSchema, extra: InputSchema, overrides: Record<string, unknown>): Record<string, unknown> {
		const base = Object.fromEntries(
			Object.entries(s).map(([key, field]) => [key, field.default ?? (field.type === "boolean" ? false : "")])
		);
		const extraBase = Object.fromEntries(
			Object.entries(extra).map(([key, field]) => [key, field.default ?? (field.type === "boolean" ? false : "")])
		);
		return { ...base, ...extraBase, ...overrides };
	}

	// svelte-ignore state_referenced_locally
	let formData: Record<string, unknown> = $state(buildDefaults(schema, extraVarSchema, defaults));

	// Re-seed when project variables or defaults change (e.g. async store load)
	$effect(() => {
		formData = buildDefaults(schema, extraVarSchema, defaults);
	});

	let errorMsg = $state("");

	// Auto-discover custom components at build time
	const customModules = import.meta.glob("$lib/custom/*.svelte", { eager: true }) as Record<
		string,
		{ default: Component }
	>;

	function getCustomComponent(filename: string): Component | undefined {
		for (const [path, mod] of Object.entries(customModules)) {
			if (path.endsWith(`/${filename}`)) return mod.default;
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = "";

		// Validate required fields
		for (const [key, field] of Object.entries(schema)) {
			if (field.required) {
				const val = formData[key];
				if (val === undefined || val === null || val === "") {
					errorMsg = `${field.label} is required`;
					return;
				}
			}
		}

		// Build clean input (omit empty optional fields)
		const input: Record<string, unknown> = {};
		for (const [key, field] of Object.entries({ ...schema, ...extraVarSchema })) {
			const val = formData[key];
			if (val !== undefined && val !== null && val !== "") {
				input[key] = val;
			} else if (field.type === "boolean") {
				input[key] = val;
			}
		}

		onsubmit(input);
	}
</script>

{#snippet renderField(key: string, field: InputSchema[string])}
	<div>
		<label for={`field-${key}`} class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">
			{field.label}
			{#if field.required}<span class="text-red-400">*</span>{/if}
		</label>
		{#if field.description}
			<p class="mb-1.5 text-xs text-[var(--color-text-muted)]">{field.description}</p>
		{/if}

		{#if field.type === "text"}
			<textarea
				id={`field-${key}`}
				bind:value={() => formData[key] as string, (v) => (formData[key] = v)}
				rows="4"
				class={inputClass}
			></textarea>
		{:else if field.type === "number"}
			<input
				id={`field-${key}`}
				type="number"
				bind:value={() => formData[key] as number, (v) => (formData[key] = v)}
				class={inputClass}
			/>
		{:else if field.type === "boolean"}
			<input
				id={`field-${key}`}
				type="checkbox"
				bind:checked={() => formData[key] as boolean, (v) => (formData[key] = v)}
				class="rounded border-[var(--color-border)] bg-[var(--color-surface)]"
			/>
		{:else if field.type === "select"}
			<select
				id={`field-${key}`}
				bind:value={() => formData[key] as string, (v) => (formData[key] = v)}
				class={inputClass}
			>
				<option value="">-- Select --</option>
				{#each field.options ?? [] as opt}
					<option value={opt}>{opt}</option>
				{/each}
			</select>
		{:else if field.type === "custom" && field.component}
			{@const CustomComp = getCustomComponent(field.component)}
			{#if CustomComp}
				<CustomComp bind:value={() => formData[key], (v) => (formData[key] = v)} {field} />
			{:else}
				<input
					id={`field-${key}`}
					type="text"
					bind:value={() => formData[key] as string, (v) => (formData[key] = v)}
					class={inputClass}
				/>
			{/if}
		{:else if field.type === "file-path"}
			<FilePicker bind:value={() => formData[key] as string, (v) => (formData[key] = v)} placeholder={field.description} />
		{:else}
			<!-- string -->
			<input
				id={`field-${key}`}
				type="text"
				bind:value={() => formData[key] as string, (v) => (formData[key] = v)}
				class={inputClass}
			/>
		{/if}
	</div>
{/snippet}

<form onsubmit={handleSubmit} class="space-y-4">
	{#each Object.entries(schema) as [key, field]}
		{@render renderField(key, field)}
	{/each}

	{#if Object.keys(extraVarSchema).length > 0}
		<div class="border-t border-[var(--color-border)] pt-4">
			<h4 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">Project Variables</h4>
			{#each Object.entries(extraVarSchema) as [key, field]}
				{@render renderField(key, field)}
			{/each}
		</div>
	{/if}

	{#if errorMsg}
		<p class="text-sm text-red-400">{errorMsg}</p>
	{/if}

	<button
		type="submit"
		disabled={submitting}
		class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
	>
		{submitting ? "Starting..." : "Run"}
	</button>
</form>
