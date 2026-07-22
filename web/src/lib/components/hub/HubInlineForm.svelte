<!--
  HubInlineForm — the INLINE on-page form node (`type: "form"`). The
  page-embedded sibling of the HubPageView form DIALOG: same validated
  field shape, but the inputs live in the page flow, so an extension can
  offer a full edit surface without a modal.

  Every input is host-owned; only validated display strings (labels,
  placeholders, prefills) come from the page tree. Submit merges EVERY
  field's current value into `action.payload[field]` (empty string =
  clear-to-empty, matching the dialog's semantics) and dispatches through
  the caller's `onAction` — the same gated path buttons use. The server
  validator strips `prompt`/`form` off the node's action, so a submit can
  never open a second collection dialog; `confirm` still flows through
  the host confirm dialog.

  Refresh reconciliation: the PARENT renderer keys this component on the
  fields' prefill signature, so a server-side change (e.g. the save
  round-tripping back through SSE) remounts with fresh prefills, while
  re-pulls that change nothing preserve in-progress typing.
-->
<script lang="ts">
	import type { PageAction, PageFormNode } from "$lib/hub";

	let {
		node,
		onAction,
	}: {
		node: PageFormNode;
		onAction?: (action: PageAction) => void;
	} = $props();

	// svelte-ignore state_referenced_locally -- intentional initial-value
	// capture: the parent keys this component on the fields' prefill
	// signature, so a server-side prefill change REMOUNTS (fresh init) while
	// a no-change re-render preserves the user's in-progress typing.
	let values = $state<Record<string, string>>(
		Object.fromEntries(node.fields.map((f) => [f.field, f.value ?? ""])),
	);

	function submit() {
		if (!onAction) return;
		const payload: Record<string, string | number | boolean> = {
			...(node.action.payload ?? {}),
		};
		for (const f of node.fields) payload[f.field] = values[f.field] ?? "";
		onAction({
			event: node.action.event,
			payload,
			...(node.action.confirm !== undefined ? { confirm: node.action.confirm } : {}),
		});
	}
</script>

<form
	class="space-y-3"
	data-testid="hub-inline-form"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	{#each node.fields as field (field.field)}
		<div>
			<label
				class="block text-xs font-medium text-[var(--color-text-secondary)]"
				for={`hub-inline-field-${field.field}`}
			>
				{field.label}
			</label>
			{#if field.multiline}
				<textarea
					id={`hub-inline-field-${field.field}`}
					rows="3"
					class="mt-1 w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
					data-testid={`hub-inline-field-${field.field}`}
					bind:value={values[field.field]}
					placeholder={field.placeholder ?? ""}
					maxlength={field.maxLength ?? 200}
				></textarea>
			{:else}
				<input
					id={`hub-inline-field-${field.field}`}
					type="text"
					class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
					data-testid={`hub-inline-field-${field.field}`}
					bind:value={values[field.field]}
					placeholder={field.placeholder ?? ""}
					maxlength={field.maxLength ?? 200}
					autocomplete="off"
				/>
			{/if}
		</div>
	{/each}
	<div class="flex justify-end">
		<button
			type="submit"
			class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] hover:opacity-90"
			data-testid="hub-inline-form-submit"
		>
			{node.submitLabel ?? "Save"}
		</button>
	</div>
</form>
