<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";
	import ModelSearchPicker from "$lib/components/ModelSearchPicker.svelte";
	import ExtensionSearchPicker from "$lib/components/ExtensionSearchPicker.svelte";
	import { CURRENT_MODEL_SENTINEL } from "$lib/api";

	let {
		initial = {},
		onsubmit,
		submitting = false,
	}: {
		initial?: Record<string, unknown>;
		onsubmit: (data: Record<string, unknown>) => void;
		submitting?: boolean;
	} = $props();

	let name = $state((initial.name as string) ?? "");
	let description = $state((initial.description as string) ?? "");
	let prompt = $state((initial.prompt as string) ?? "");
	let outputFormat = $state((initial.outputFormat as string) ?? "text");
	let selectedModel = $state<{ provider: string; model: string } | null>(
		initial.provider && initial.model
			? { provider: initial.provider as string, model: initial.model as string }
			: { provider: CURRENT_MODEL_SENTINEL, model: CURRENT_MODEL_SENTINEL }
	);
	let temperature = $state((initial.temperature as number | null) ?? null);
	let maxTokens = $state((initial.maxTokens as number | null) ?? null);
	let category = $state((initial.category as string) ?? "");
	// Extensions attached to this agent (runtime wires their tools when the
	// agent is @mentioned — see src/runtime/mention-wiring.ts). Pre-populates
	// from the saved config so users see the selection on edit/reload.
	let extensions = $state<string[]>(
		Array.isArray(initial.extensions) ? (initial.extensions as string[]) : [],
	);

	// Dynamic input schema builder
	let fields = $state<{ key: string; type: string; label: string; required: boolean }[]>(
		initial.inputSchema
			? Object.entries(initial.inputSchema as Record<string, { type: string; label: string; required?: boolean }>).map(
					([key, f]) => ({ key, type: f.type ?? "string", label: f.label ?? key, required: f.required ?? false }),
				)
			: [],
	);

	let errorMsg = $state("");

	function addField() {
		fields = [...fields, { key: "", type: "string", label: "", required: false }];
	}

	function removeField(idx: number) {
		fields = fields.filter((_, i) => i !== idx);
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = "";

		if (!name.trim()) {
			errorMsg = "Name is required";
			return;
		}
		if (!prompt.trim()) {
			errorMsg = "System prompt is required";
			return;
		}

		const inputSchema: Record<string, unknown> = {};
		for (const f of fields) {
			if (f.key.trim()) {
				inputSchema[f.key.trim()] = {
					type: f.type,
					label: f.label || f.key,
					required: f.required,
				};
			}
		}

		onsubmit({
			name: name.trim(),
			description: description.trim(),
			prompt: prompt.trim(),
			outputFormat,
			...(selectedModel ? { provider: selectedModel.provider, model: selectedModel.model } : {}),
			...(temperature != null ? { temperature } : {}),
			...(maxTokens != null ? { maxTokens } : {}),
			...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
			...(category.trim() ? { category: category.trim() } : {}),
			extensions,
		});
	}
</script>

<form onsubmit={handleSubmit} class="space-y-4">
	<div>
		<label for="ac-name" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Name</label>
		<input id="ac-name" type="text" bind:value={name} class={inputClass} placeholder="my-agent" />
	</div>

	<div>
		<label for="ac-desc" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Description</label>
		<input id="ac-desc" type="text" bind:value={description} class={inputClass} placeholder="What does this agent do?" />
	</div>

	<div>
		<label for="ac-prompt" class="mb-1 flex items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)]">System Prompt <InfoTooltip key="agent.system-prompt" /></label>
		<textarea id="ac-prompt" bind:value={prompt} rows="6" class={inputClass} placeholder="You are a helpful assistant that..."></textarea>
	</div>

	<div class="grid grid-cols-2 gap-4">
		<div>
			<label for="ac-format" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Output Format</label>
			<select id="ac-format" bind:value={outputFormat} class={inputClass}>
				<option value="text">Text</option>
				<option value="json">JSON</option>
			</select>
		</div>

		<div class="col-span-2">
			<label class="mb-1 flex items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)]">Model & Provider <InfoTooltip key="agent.model" /></label>
			<ModelSearchPicker
				selected={selectedModel}
				placeholder="Search models... (system default)"
				onselect={(provider, model) => { selectedModel = { provider, model }; }}
				onclear={() => { selectedModel = { provider: CURRENT_MODEL_SENTINEL, model: CURRENT_MODEL_SENTINEL }; }}
			/>
			{#if selectedModel && !(selectedModel.provider === CURRENT_MODEL_SENTINEL && selectedModel.model === CURRENT_MODEL_SENTINEL)}
				<button
					type="button"
					class="mt-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
					onclick={() => { selectedModel = { provider: CURRENT_MODEL_SENTINEL, model: CURRENT_MODEL_SENTINEL }; }}
				>
					Reset to current chat model
				</button>
			{/if}
		</div>

		<div>
			<label for="ac-temp" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Temperature</label>
			<input id="ac-temp" type="number" bind:value={temperature} class={inputClass} step="0.1" min="0" max="2" />
		</div>

		<div>
			<label for="ac-tokens" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Max Tokens</label>
			<input id="ac-tokens" type="number" bind:value={maxTokens} class={inputClass} min="1" />
		</div>

		<div>
			<label for="ac-category" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Category</label>
			<input id="ac-category" type="text" bind:value={category} class={inputClass} placeholder='e.g. Finance, Engineering, or "team"' />
		</div>
	</div>

	<!-- Tools / Extensions — attaches extension tools to this agent -->
	<div>
		<label class="mb-1 flex items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)]">
			Tools &amp; Extensions <InfoTooltip key="agent.extensions" />
		</label>
		<p class="mb-2 text-xs text-[var(--color-text-muted)]">
			Attach extensions to give this agent access to their tools. Selected extensions appear as chips below the picker.
		</p>
		<ExtensionSearchPicker
			selected={extensions}
			placeholder="Search extensions to attach..."
			onchange={(ids) => { extensions = ids; }}
		/>
	</div>

	<!-- Input Schema Builder -->
	<div>
		<div class="mb-2 flex items-center justify-between">
			<label class="text-sm font-medium text-[var(--color-text-secondary)]">Input Fields</label>
			<button type="button" onclick={addField} class="rounded bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]">
				+ Add Field
			</button>
		</div>
		{#each fields as field, idx}
			<div class="mb-2 flex items-center gap-2">
				<label class="sr-only" for="field-key-{idx}">Field key</label>
				<input id="field-key-{idx}" type="text" bind:value={field.key} placeholder="key" class="{inputClass} w-28" />
				<label class="sr-only" for="field-type-{idx}">Field type</label>
				<select id="field-type-{idx}" bind:value={field.type} class="{inputClass} w-24">
					<option value="string">string</option>
					<option value="text">text</option>
					<option value="number">number</option>
					<option value="boolean">boolean</option>
					<option value="select">select</option>
				</select>
				<label class="sr-only" for="field-label-{idx}">Field label</label>
				<input id="field-label-{idx}" type="text" bind:value={field.label} placeholder="Label" class="{inputClass} flex-1" />
				<label class="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
					<input type="checkbox" bind:checked={field.required} />
					Req
				</label>
				<button type="button" onclick={() => removeField(idx)} class="text-red-400 hover:text-red-300">&times;</button>
			</div>
		{/each}
	</div>

	{#if errorMsg}
		<p class="text-sm text-red-400">{errorMsg}</p>
	{/if}

	<button
		type="submit"
		disabled={submitting}
		class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
	>
		{submitting ? "Saving..." : "Save Agent"}
	</button>
</form>
