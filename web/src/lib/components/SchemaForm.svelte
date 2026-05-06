<!--
  SchemaForm — generic, controlled form renderer driven by a SettingsSchema.

  Used by:
    - Per-extension settings panels on /extensions/[id]

  AgentInputForm intentionally does NOT delegate here — see that component's
  header comment for the schema-incompatibility rationale.

  Contract:
    - `values` is fully controlled by the parent (bind from a $state).
    - Local edits propagate via `oninput(next)` so the parent's binding stays
      authoritative — we never mutate the prop directly.
    - A hidden submit button lets Enter trigger `onsubmit` even when the
      parent renders its own visible submit affordance outside this form.
-->

<script lang="ts">
  import type {
    SettingsSchema,
    SettingsField,
  } from "$server/extensions/types";
  import { inputClass } from "$lib/styles.js";

  let {
    schema,
    values,
    disabled = false,
    oninput,
    onsubmit,
  }: {
    schema: SettingsSchema;
    values: Record<string, unknown>;
    disabled?: boolean;
    oninput?: (next: Record<string, unknown>) => void;
    onsubmit?: (next: Record<string, unknown>) => void | Promise<void>;
  } = $props();

  function setValue(key: string, value: unknown): void {
    const next = { ...values, [key]: value };
    oninput?.(next);
  }

  function effectiveValue(key: string, field: SettingsField): unknown {
    const v = values[key];
    if (v !== undefined) return v;
    if ("default" in field && field.default !== undefined) return field.default;
    if (field.type === "boolean") return false;
    if (field.type === "number") return "";
    return "";
  }

  function coerceNumber(raw: string, field: Extract<SettingsField, { type: "number" }>): number | "" {
    if (raw === "") return "";
    const n = field.integer ? parseInt(raw, 10) : Number(raw);
    return Number.isNaN(n) ? "" : n;
  }

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (disabled) return;
    await onsubmit?.(values);
  }

  let entries = $derived(Object.entries(schema));
  let isEmpty = $derived(entries.length === 0);
</script>

{#if isEmpty}
  <p class="text-sm text-[var(--color-text-muted)]" data-testid="schema-form-empty">
    No configurable settings.
  </p>
{:else}
  <form onsubmit={handleSubmit} class="space-y-4" data-testid="schema-form">
    {#each entries as [key, field] (key)}
      <div data-testid={`schema-field-${key}`}>
        <label
          for={`schema-field-${key}`}
          class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]"
        >
          {field.label}
        </label>
        {#if field.description}
          <p class="mb-1.5 text-xs text-[var(--color-text-muted)]">{field.description}</p>
        {/if}

        {#if field.type === "select"}
          <select
            id={`schema-field-${key}`}
            class={inputClass}
            {disabled}
            value={effectiveValue(key, field) as string}
            onchange={(e) => setValue(key, (e.currentTarget as HTMLSelectElement).value)}
            data-testid={`schema-input-${key}`}
          >
            {#each field.options as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        {:else if field.type === "text"}
          <input
            id={`schema-field-${key}`}
            type="text"
            class={inputClass}
            {disabled}
            value={effectiveValue(key, field) as string}
            minlength={field.minLength ?? undefined}
            maxlength={field.maxLength ?? undefined}
            pattern={field.pattern ?? undefined}
            oninput={(e) => setValue(key, (e.currentTarget as HTMLInputElement).value)}
            data-testid={`schema-input-${key}`}
          />
        {:else if field.type === "number"}
          <input
            id={`schema-field-${key}`}
            type="number"
            class={inputClass}
            {disabled}
            value={effectiveValue(key, field) as number | ""}
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            step={field.integer ? 1 : (field.step ?? undefined)}
            oninput={(e) => setValue(key, coerceNumber((e.currentTarget as HTMLInputElement).value, field))}
            data-testid={`schema-input-${key}`}
          />
        {:else if field.type === "boolean"}
          <input
            id={`schema-field-${key}`}
            type="checkbox"
            class="h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface)]"
            {disabled}
            checked={effectiveValue(key, field) as boolean}
            onchange={(e) => setValue(key, (e.currentTarget as HTMLInputElement).checked)}
            data-testid={`schema-input-${key}`}
          />
        {/if}
      </div>
    {/each}

    <button
      type="submit"
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      data-testid="schema-form-submit"
    >Submit</button>
  </form>
{/if}
