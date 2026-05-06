<!--
  SettingsPanel — one form panel on the extension detail page.

  Owns the local edit buffer + Save/Reset buttons. Delegates field rendering
  to the generic <SchemaForm/>. Submission/reset hooks are passed in by the
  parent so this component stays scope-agnostic.
-->

<script lang="ts">
  import type { SettingsSchema } from "$server/extensions/types";
  import SchemaForm from "$lib/components/SchemaForm.svelte";

  let {
    title,
    schema,
    values,
    canReset = false,
    onsave,
    onreset,
    testid,
  }: {
    title: string;
    schema: SettingsSchema;
    values: Record<string, unknown>;
    canReset?: boolean;
    onsave: (next: Record<string, unknown>) => Promise<void>;
    onreset?: () => Promise<void>;
    testid?: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  let draft = $state<Record<string, unknown>>({ ...values });
  let saving = $state(false);
  let resetting = $state(false);

  $effect(() => {
    draft = { ...values };
  });

  async function handleSave(): Promise<void> {
    saving = true;
    try {
      await onsave(draft);
    } finally {
      saving = false;
    }
  }

  async function handleReset(): Promise<void> {
    if (!onreset) return;
    resetting = true;
    try {
      await onreset();
    } finally {
      resetting = false;
    }
  }
</script>

<div
  class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
  data-testid={testid ?? "settings-panel"}
>
  <h4 class="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">{title}</h4>

  <SchemaForm
    {schema}
    values={draft}
    disabled={saving || resetting}
    oninput={(next) => (draft = next)}
    onsubmit={handleSave}
  />

  {#if Object.keys(schema).length > 0}
    <div class="mt-4 flex items-center gap-2">
      <button
        type="button"
        onclick={handleSave}
        disabled={saving || resetting}
        class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
        data-testid={`${testid ?? "settings-panel"}-save`}
      >
        {saving ? "Saving..." : "Save"}
      </button>
      {#if canReset && onreset}
        <button
          type="button"
          onclick={handleReset}
          disabled={saving || resetting}
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-secondary)] disabled:opacity-50"
          data-testid={`${testid ?? "settings-panel"}-reset`}
        >
          {resetting ? "Resetting..." : "Reset to default"}
        </button>
      {/if}
    </div>
  {/if}
</div>
