<script lang="ts">
	import type { ToolDefinition } from '../../../../src/extensions/types';
	import { formatComponentMap, getFormatComponent } from './ui/format-map';

	let {
		tool,
		extensionName,
		initialValues = {},
		sharedValues = {},
		onconfirm,
		onclose,
	}: {
		tool: ToolDefinition;
		extensionName: string;
		initialValues?: Record<string, unknown>;
		sharedValues?: Record<string, string>;
		onconfirm: (input: Record<string, unknown>) => void;
		onclose: () => void;
	} = $props();

	// Derive schema info
	let properties = $derived(
		(tool.inputSchema?.properties as Record<string, Record<string, unknown>>) ?? {},
	);
	let requiredFields = $derived((tool.inputSchema?.required as string[]) ?? []);
	let propertyKeys = $derived(Object.keys(properties));

	// Form values - initialize from initialValues or defaults
	let values = $state<Record<string, unknown>>({});
	let errors = $state<Record<string, string>>({});

	$effect(() => {
		const init: Record<string, unknown> = {};
		for (const key of propertyKeys) {
			if (initialValues && key in initialValues) {
				init[key] = initialValues[key];
			} else {
				const prop = properties[key];
				// Pre-fill from x-shared via sharedValues prop
				const sharedKey = prop['x-shared'] as string | undefined;
				if (sharedKey && sharedValues[sharedKey]) {
					init[key] = sharedValues[sharedKey];
				} else if (prop.format === 'tag-input' && prop.type === 'array') init[key] = [];
				else if (prop.type === 'boolean') init[key] = false;
				else if (prop.type === 'number' || prop.type === 'integer') init[key] = '';
				else init[key] = '';
			}
		}
		values = init;
		errors = {};
	});

	function getFieldType(prop: Record<string, unknown>): string {
		if (prop.enum) return 'enum';
		const t = prop.type as string;
		if (t === 'boolean') return 'boolean';
		if (t === 'number' || t === 'integer') return 'number';
		if (t === 'object' || t === 'array') return 'json';
		return 'string';
	}

	function validate(): boolean {
		const newErrors: Record<string, string> = {};
		for (const key of propertyKeys) {
			const prop = properties[key];
			const val = values[key];
			const isRequired = requiredFields.includes(key);
			const fieldType = getFieldType(prop);

			if (isRequired && (val === '' || val === undefined || val === null)) {
				newErrors[key] = 'Required';
				continue;
			}

			if (val === '' || val === undefined) continue;

			if (fieldType === 'number') {
				const n = Number(val);
				if (isNaN(n)) {
					newErrors[key] = 'Must be a valid number';
				}
			}
			if (fieldType === 'json' && typeof val === 'string' && val.trim() !== '') {
				try {
					JSON.parse(val);
				} catch {
					newErrors[key] = 'Must be valid JSON';
				}
			}
		}
		errors = newErrors;
		return Object.keys(newErrors).length === 0;
	}

	function collectValues(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const key of propertyKeys) {
			const prop = properties[key];
			const val = values[key];
			const fieldType = getFieldType(prop);

			if (val === '' || val === undefined) continue;

			// Format-aware collection: tag-input arrays stay as arrays, not stringified
			if (prop.format && prop.format in formatComponentMap) {
				if (prop.format === 'tag-input' && prop.type === 'array' && Array.isArray(val)) {
					result[key] = val;
				} else if (prop.format === 'tag-input' && typeof val === 'object' && Array.isArray(val)) {
					result[key] = (val as string[]).join(', ');
				} else {
					result[key] = val;
				}
				continue;
			}

			if (fieldType === 'number') result[key] = Number(val);
			else if (fieldType === 'boolean') result[key] = val;
			else if (fieldType === 'json' && typeof val === 'string') {
				try {
					result[key] = JSON.parse(val);
				} catch {
					result[key] = val;
				}
			} else result[key] = val;
		}
		return result;
	}

	function handleSubmit() {
		if (!validate()) return;
		onconfirm(collectValues());
	}

	function handleFormKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function handleWrapperClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="absolute bottom-full left-0 right-0 z-50 mb-2" onclick={handleWrapperClick}>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<form
		class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
		onkeydown={handleFormKeydown}
	>
		<!-- Header -->
		<div class="border-b border-[var(--color-border)] px-4 py-2">
			<span class="text-xs text-[var(--color-text-muted)]">{extensionName}</span>
			<span class="text-xs text-[var(--color-text-muted)]"> &rsaquo; </span>
			<span class="text-sm font-medium text-[var(--color-text-primary)]">{tool.name}</span>
		</div>

		<!-- Fields -->
		<div class="flex flex-col gap-3 px-4 py-3 max-h-[280px] overflow-y-auto">
			{#each propertyKeys as key, i}
				{@const prop = properties[key]}
				{@const fieldType = getFieldType(prop)}
				{@const isRequired = requiredFields.includes(key)}
				{@const isLast = i === propertyKeys.length - 1}

				<div class="flex flex-col gap-1">
					<label for="field-{key}" class="text-xs font-medium text-[var(--color-text-secondary)]">
						{key}{#if isRequired}<span class="text-red-400">*</span>{/if}
					</label>

					{#if prop.description}
						<span class="text-[10px] text-[var(--color-text-muted)]">{prop.description}</span>
					{/if}

					{#if prop.format && prop.format in formatComponentMap && values[key] !== undefined}
					<svelte:component
						this={getFormatComponent(prop.format)}
						bind:value={values[key]}
						size="sm"
						disabled={false}
						placeholder={prop.description || ''}
						options={{ ...(prop['x-options'] as Record<string, unknown> ?? {}), _format: prop.format }}
					/>
				{:else if prop.format}
					<span class="text-red-400 text-xs">Unrecognized format: &quot;{prop.format}&quot;</span>
				{:else if fieldType === 'boolean'}
						<input
							id="field-{key}"
							type="checkbox"
							checked={!!values[key]}
							onchange={(e) => (values[key] = e.currentTarget.checked)}
							class="h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-primary)]"
						/>
					{:else if fieldType === 'enum'}
						<select
							id="field-{key}"
							value={values[key] as string}
							onchange={(e) => (values[key] = e.currentTarget.value)}
							class="rounded border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
						>
							<option value="">Select...</option>
							{#each (prop.enum as string[]) ?? [] as opt}
								<option value={opt}>{opt}</option>
							{/each}
						</select>
					{:else if fieldType === 'number'}
						<input
							id="field-{key}"
							type="number"
							value={values[key] as string}
							oninput={(e) => (values[key] = e.currentTarget.value)}
							class="rounded border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
						/>
					{:else if fieldType === 'json'}
						<textarea
							id="field-{key}"
							value={values[key] as string}
							oninput={(e) => (values[key] = e.currentTarget.value)}
							rows="3"
							placeholder="Enter JSON..."
							class="rounded border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)]"
						></textarea>
					{:else}
						<input
							id="field-{key}"
							type="text"
							value={values[key] as string}
							oninput={(e) => (values[key] = e.currentTarget.value)}
							class="rounded border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
						/>
					{/if}

					{#if errors[key]}
						<span class="text-[10px] text-red-400">{errors[key]}</span>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Buttons -->
		<div class="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2">
			<button
				type="button"
				onclick={onclose}
				class="rounded px-3 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
			>
				Cancel
			</button>
			<button
				type="submit"
				class="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500"
			>
				Add
			</button>
		</div>
	</form>
</div>
