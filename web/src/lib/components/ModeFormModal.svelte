<script lang="ts">
	import { createMode, updateMode as apiUpdateMode, type Mode } from "$lib/api";

	let {
		open = false,
		editMode = null,
		onsaved,
		onclose,
	}: {
		open: boolean;
		editMode?: Mode | null;
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
		toolRestriction: "all" as "all" | "read-only" | "none",
	});
	let saving = $state(false);
	let error = $state<string | null>(null);

	let isEdit = $derived(editMode !== null && editMode !== undefined);
	let title = $derived(isEdit ? "Edit Mode" : "Create Mode");
	let submitLabel = $derived(isEdit ? "Save Changes" : "Create Mode");

	// Populate form when editMode changes
	$effect(() => {
		if (editMode && open) {
			form = {
				name: editMode.name,
				slug: editMode.slug,
				icon: editMode.icon ?? "",
				description: editMode.description,
				systemPromptInstruction: editMode.systemPromptInstruction,
				instructionPosition: editMode.instructionPosition,
				toolRestriction: editMode.toolRestriction,
			};
		} else if (!editMode && open) {
			form = { name: "", slug: "", icon: "", description: "", systemPromptInstruction: "", instructionPosition: "prepend", toolRestriction: "all" };
		}
	});

	function autoSlug() {
		if (!isEdit) {
			form.slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
		}
	}

	function reset() {
		form = { name: "", slug: "", icon: "", description: "", systemPromptInstruction: "", instructionPosition: "prepend", toolRestriction: "all" };
		error = null;
		saving = false;
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
			if (isEdit && editMode) {
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
	>
		<div class="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-2xl mx-4">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
				<button onclick={handleClose} class="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors">
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<div class="space-y-3">
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="block text-xs text-[var(--color-text-secondary)] mb-1">Name</label>
						<input bind:value={form.name} oninput={autoSlug} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" placeholder="e.g. Debug" />
					</div>
					<div>
						<label class="block text-xs text-[var(--color-text-secondary)] mb-1">Slug</label>
						<input bind:value={form.slug} disabled={isEdit} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none font-mono disabled:opacity-50" placeholder="debug" />
					</div>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="block text-xs text-[var(--color-text-secondary)] mb-1">Icon (emoji)</label>
						<input bind:value={form.icon} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" maxlength="10" />
					</div>
					<div>
						<label class="block text-xs text-[var(--color-text-secondary)] mb-1">Tool Restriction</label>
						<select bind:value={form.toolRestriction} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none">
							<option value="all">All tools</option>
							<option value="read-only">Read-only</option>
							<option value="none">No tools</option>
						</select>
					</div>
				</div>
				<div>
					<label class="block text-xs text-[var(--color-text-secondary)] mb-1">Description</label>
					<input bind:value={form.description} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" placeholder="Short description" maxlength="500" />
				</div>
				<div>
					<label class="block text-xs text-[var(--color-text-secondary)] mb-1">System Prompt Instruction</label>
					<textarea bind:value={form.systemPromptInstruction} rows={4} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none resize-y" placeholder="Instructions added to the system prompt when this mode is active..."></textarea>
				</div>
				<div>
					<label class="block text-xs text-[var(--color-text-secondary)] mb-1">Instruction Position</label>
					<select bind:value={form.instructionPosition} class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none">
						<option value="prepend">Prepend (before system prompt)</option>
						<option value="append">Append (after system prompt)</option>
						<option value="replace">Replace (override system prompt)</option>
					</select>
				</div>

				{#if error}
					<p class="text-xs text-red-400">{error}</p>
				{/if}

				<div class="flex gap-2 pt-1">
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
				</div>
			</div>
		</div>
	</div>
{/if}
