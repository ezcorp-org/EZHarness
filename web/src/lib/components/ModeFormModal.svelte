<script lang="ts">
	import { createMode, updateMode as apiUpdateMode, type Mode } from "$lib/api";
	import Tooltip from "$lib/components/Tooltip.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";
	import ExtensionSearchPicker from "$lib/components/ExtensionSearchPicker.svelte";
	import ExtensionAttachPicker from "$lib/components/ExtensionAttachPicker.svelte";
	import ExtensionToolSelector from "$lib/components/ExtensionToolSelector.svelte";
	import { onMount } from "svelte";

	let {
		open = false,
		editMode = null,
		viewMode = false,
		onsaved,
		onclose,
	}: {
		open: boolean;
		editMode?: Mode | null;
		viewMode?: boolean;
		onsaved: (mode: Mode) => void;
		onclose: () => void;
	} = $props();

	let form = $state({
		name: "",
		slug: "",
		icon: "",
		description: "",
		systemPromptInstruction: "",
		instructionPosition: "prepend" as "prepend" | "append" | "replace",
		extensionIds: [] as string[],
		extensionTools: {} as Record<string, string[]>,
	});

	// Lookup table for resolving extension IDs → human names in read-only mode.
	// The picker fetches its own copy when interactive; we mirror it here so
	// the view-mode chip strip can show names without depending on the picker.
	let extensionNames = $state<Record<string, string>>({});
	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (!res.ok) return;
			const data = await res.json();
			const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.extensions) ? data.extensions : [];
			const map: Record<string, string> = {};
			for (const e of list as Array<{ id: string; name?: string }>) {
				map[e.id] = e.name ?? e.id;
			}
			extensionNames = map;
		} catch { /* non-fatal */ }
	});
	let saving = $state(false);
	let error = $state<string | null>(null);
	let isEditing = $state(true);
	// Visual attach picker (parity with AgentConfigForm). Submitting threads
	// both the selected ids and the per-card tool-scoping map through
	// handleExtensionsChange.
	let attachPickerOpen = $state(false);

	let isExisting = $derived(editMode !== null && editMode !== undefined);
	let isBuiltin = $derived(Boolean(editMode?.builtin));
	let readonly = $derived(isExisting && !isEditing);
	let title = $derived(
		isExisting ? (isEditing ? "Edit Mode" : "View Mode") : "Create Mode",
	);
	let submitLabel = $derived(isExisting ? "Save Changes" : "Create Mode");

	// Populate form and reset edit/view state when modal opens or target changes
	$effect(() => {
		if (open) {
			isEditing = !viewMode || !editMode;
			if (editMode) {
				form = {
					name: editMode.name,
					slug: editMode.slug,
					icon: editMode.icon ?? "",
					description: editMode.description,
					systemPromptInstruction: editMode.systemPromptInstruction,
					instructionPosition: editMode.instructionPosition,
					extensionIds: editMode.extensionIds ?? [],
					extensionTools: editMode.extensionTools ?? {},
				};
			} else {
				form = { name: "", slug: "", icon: "", description: "", systemPromptInstruction: "", instructionPosition: "prepend", extensionIds: [], extensionTools: {} };
			}
		}
	});

	function autoSlug() {
		if (!isExisting) {
			form.slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
		}
	}

	function reset() {
		form = { name: "", slug: "", icon: "", description: "", systemPromptInstruction: "", instructionPosition: "prepend", extensionIds: [], extensionTools: {} };
		error = null;
		saving = false;
	}

	// Drop per-tool subsets for extensions that are no longer attached, so the
	// persisted extensionTools map never carries stale keys. The inline picker
	// passes ids only; the visual attach-picker also threads a per-card scoping
	// map, which (when supplied) takes precedence for the supplied ids.
	function handleExtensionsChange(ids: string[], scoped?: Record<string, string[]>) {
		const base = scoped ?? form.extensionTools;
		const kept: Record<string, string[]> = {};
		for (const id of ids) {
			if (base[id]) kept[id] = base[id];
		}
		form.extensionIds = ids;
		form.extensionTools = kept;
	}

	function handleClose() {
		reset();
		onclose();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) handleClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") handleClose();
	}

	async function handleSubmit() {
		saving = true;
		error = null;
		try {
			let mode: Mode;
			if (isExisting && editMode) {
				mode = await apiUpdateMode(editMode.id, form);
			} else {
				mode = await createMode(form);
			}
			reset();
			onsaved(mode);
		} catch (e: any) {
			error = e.message || "Failed to save mode";
		} finally {
			saving = false;
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
		role="dialog"
		aria-modal="true"
		aria-label={title}
		tabindex={-1}
	>
		<!-- max-h + overflow: the Tools & Extensions per-tool checklist can
		     grow the form past the viewport; without a scrollable panel the
		     footer buttons land off-screen and can't be reached at all
		     (backdrop is fixed, the page behind doesn't scroll). -->
		<div class="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-2xl mx-4">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
				<div class="flex items-center gap-1">
					{#if isExisting && !isEditing}
						{#if isBuiltin}
							<Tooltip text="Built-in modes cannot be edited." position="bottom">
								<button
									type="button"
									disabled
									aria-label="Edit (disabled — built-in mode)"
									class="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-text-muted)] opacity-50 cursor-not-allowed"
								>
									Edit
								</button>
							</Tooltip>
						{:else}
							<button
								type="button"
								onclick={() => { isEditing = true; }}
								aria-label="Edit mode"
								class="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
							>
								Edit
							</button>
						{/if}
					{/if}
					<button type="button" onclick={handleClose} aria-label="Close" class="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors p-1">
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
			</div>

			<div class="space-y-3">
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label for="mode-form-name" class="block text-xs text-[var(--color-text-secondary)] mb-1">Name</label>
						<input id="mode-form-name" bind:value={form.name} oninput={autoSlug} readonly={readonly} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none read-only:opacity-70 read-only:cursor-not-allowed" placeholder="e.g. Debug" />
					</div>
					<div>
						<label for="mode-form-slug" class="block text-xs text-[var(--color-text-secondary)] mb-1">Slug</label>
						<input id="mode-form-slug" bind:value={form.slug} disabled={isExisting} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none font-mono disabled:opacity-50" placeholder="debug" />
					</div>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label for="mode-form-icon" class="block text-xs text-[var(--color-text-secondary)] mb-1">Icon (emoji)</label>
						<input id="mode-form-icon" bind:value={form.icon} readonly={readonly} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none read-only:opacity-70 read-only:cursor-not-allowed" maxlength="10" />
					</div>
					<div></div>
				</div>
				<!-- Tools & Extensions — attaches extension tools to this mode. Mirrors AgentConfigForm. -->
				<div>
					<label class="mb-1 flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
						Tools &amp; Extensions <InfoTooltip key="mode.extensions" />
					</label>
					<p class="mb-2 text-xs text-[var(--color-text-muted)]">
						Attach extensions to give this mode access to their tools. Selected extensions appear as chips below the picker.
					</p>
					{#if readonly}
						{#if editMode?.toolRestriction === "allowlist" && (editMode?.allowedTools?.length ?? 0) > 0}
							<!-- Built-in allowlist modes (e.g. Ez) carry an explicit tool-name
							     list instead of attached extensions. Show it read-only so the
							     view modal no longer dead-ends on "No extensions attached." -->
							<p class="mb-1 text-xs text-[var(--color-text-secondary)]">Built-in tool allowlist</p>
							<div data-testid="mode-allowlist-tools" class="flex flex-wrap gap-1">
								{#each editMode?.allowedTools ?? [] as toolName (toolName)}
									<span class="inline-flex max-w-full items-center rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 font-mono text-xs text-[var(--color-text-secondary)]">
										<span class="truncate">{toolName}</span>
									</span>
								{/each}
							</div>
						{:else if form.extensionIds.length === 0}
							<p class="text-xs text-[var(--color-text-muted)] italic">No extensions attached.</p>
						{:else}
							<div data-testid="mode-readonly-extension-chips" class="flex flex-wrap gap-1">
								{#each form.extensionIds as extId (extId)}
									<span class="inline-flex max-w-full items-center rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
										<span class="truncate">{extensionNames[extId] ?? extId}</span>
									</span>
								{/each}
							</div>
							<div class="mt-2">
								<ExtensionToolSelector extensionIds={form.extensionIds} value={form.extensionTools} readonly />
							</div>
						{/if}
					{:else}
						<ExtensionSearchPicker
							selected={form.extensionIds}
							placeholder="Search extensions to attach..."
							onchange={handleExtensionsChange}
						/>
						<button
							type="button"
							onclick={() => (attachPickerOpen = true)}
							data-testid="open-extension-attach-picker"
							class="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
							style="min-height: 36px;"
						>
							<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
							</svg>
							Browse extensions
						</button>
						{#if form.extensionIds.length > 0}
							<p class="mt-2 text-xs text-[var(--color-text-muted)]">
								Pick specific tools per extension, or leave all checked to grant every tool (including ones added later).
							</p>
							<div class="mt-1">
								<ExtensionToolSelector
									extensionIds={form.extensionIds}
									value={form.extensionTools}
									onchange={(map) => { form.extensionTools = map; }}
								/>
							</div>
						{/if}
					{/if}
				</div>
				<div>
					<label for="mode-form-description" class="block text-xs text-[var(--color-text-secondary)] mb-1">Description</label>
					<input id="mode-form-description" bind:value={form.description} readonly={readonly} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none read-only:opacity-70 read-only:cursor-not-allowed" placeholder="Short description" maxlength="500" />
				</div>
				<div>
					<label for="mode-form-system-prompt" class="block text-xs text-[var(--color-text-secondary)] mb-1">System Prompt Instruction</label>
					<textarea id="mode-form-system-prompt" bind:value={form.systemPromptInstruction} readonly={readonly} rows={4} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none resize-y read-only:opacity-70 read-only:cursor-not-allowed" placeholder="Instructions added to the system prompt when this mode is active..."></textarea>
				</div>
				<div>
					<label for="mode-form-instruction-position" class="block text-xs text-[var(--color-text-secondary)] mb-1">Instruction Position</label>
					<select id="mode-form-instruction-position" bind:value={form.instructionPosition} disabled={readonly} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-70 disabled:cursor-not-allowed">
						<option value="prepend">Prepend (before system prompt)</option>
						<option value="append">Append (after system prompt)</option>
						<option value="replace">Replace (override system prompt)</option>
					</select>
				</div>

				{#if error}
					<p class="text-xs text-red-400">{error}</p>
				{/if}

				<div class="flex gap-2 pt-1">
					{#if readonly}
						<button onclick={handleClose} class="rounded-md border border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors">
							Close
						</button>
					{:else}
						<button
							onclick={handleSubmit}
							disabled={saving || !form.name || !form.slug || !form.systemPromptInstruction}
							class="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
						>
							{saving ? "Saving..." : submitLabel}
						</button>
						<button onclick={handleClose} class="rounded-md border border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors">
							Cancel
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>

	<!-- Visual extension attach picker (parity with AgentConfigForm). Mounted
	     at modal scope so it overlays the form. -->
	<ExtensionAttachPicker
		open={attachPickerOpen}
		initialSelected={form.extensionIds}
		initialExtensionTools={form.extensionTools}
		onclose={() => (attachPickerOpen = false)}
		onsubmit={handleExtensionsChange}
	/>
{/if}
