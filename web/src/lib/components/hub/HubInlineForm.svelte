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

	/** EFFECTIVE visibility, evaluated transitively: a field with no
	 *  `visibleWhen` is visible; a conditional field renders (and submits)
	 *  only while its controlling sibling is ITSELF effectively visible AND
	 *  that controller's CURRENT value matches — hiding a controller
	 *  cascades to all its dependents. Reads `values` ($state), so the
	 *  template re-evaluates as the user edits — flipping a select
	 *  shows/hides whole dependent chains live. A hidden field keeps its
	 *  local value (flip back and it's still there) but is OMITTED from the
	 *  payload: absent key = "don't touch", never a clear.
	 *
	 *  Cycle guard: re-entering a field already on the evaluation path
	 *  treats THAT field as visible (fail-open) so evaluation terminates
	 *  deterministically — the server validator prunes self/dangling
	 *  references, but a two-field cycle can still arrive. */
	function isVisible(field: PageFormNode["fields"][number], visiting = new Set<string>()): boolean {
		const cond = field.visibleWhen;
		if (!cond) return true;
		if (visiting.has(field.field)) return true;
		visiting.add(field.field);
		// The server validator prunes conditions referencing unknown fields,
		// so the controlling sibling always exists (as does its `values` key,
		// initialized from `node.fields` above).
		const controller = node.fields.find((f) => f.field === cond.field)!;
		if (!isVisible(controller, visiting)) return false;
		const current = values[cond.field];
		return Array.isArray(cond.equals) ? cond.equals.includes(current) : cond.equals === current;
	}

	function submit() {
		if (!onAction) return;
		const payload: Record<string, string | number | boolean> = {
			...(node.action.payload ?? {}),
		};
		for (const f of node.fields) {
			if (!isVisible(f)) continue;
			payload[f.field] = values[f.field];
		}
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
	{#each node.fields.filter((f) => isVisible(f)) as field (field.field)}
		<div>
			<label
				class="block text-xs font-medium text-[var(--color-text-secondary)]"
				for={`hub-inline-field-${field.field}`}
			>
				{field.label}
			</label>
			{#if field.options}
				<select
					id={`hub-inline-field-${field.field}`}
					class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
					data-testid={`hub-inline-field-${field.field}`}
					bind:value={values[field.field]}
				>
					{#each field.options as opt (opt.value)}
						<option value={opt.value}>{opt.label ?? opt.value}</option>
					{/each}
				</select>
			{:else if field.multiline}
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
