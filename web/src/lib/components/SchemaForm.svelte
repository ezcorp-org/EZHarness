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
    secrets = {},
    disabled = false,
    oninput,
    onsubmit,
  }: {
    schema: SettingsSchema;
    values: Record<string, unknown>;
    /** Per secret-field existence probe from the settings GET (`{ isSet }`).
     *  Drives the Set / Not set badge and the Clear affordance — the value
     *  itself is never sent to the client. */
    secrets?: Record<string, { isSet: boolean }>;
    disabled?: boolean;
    oninput?: (next: Record<string, unknown>) => void;
    onsubmit?: (next: Record<string, unknown>) => void | Promise<void>;
  } = $props();

  function setValue(key: string, value: unknown): void {
    const next = { ...values, [key]: value };
    oninput?.(next);
  }

  function removeValue(key: string): void {
    const next = { ...values };
    delete next[key];
    oninput?.(next);
  }

  // Secret-field draft semantics: ABSENT key = leave the stored secret
  // untouched; non-empty string = replace on save; EXPLICIT "" = clear on
  // save ("" is only ever queued via the Clear button — erasing the input
  // back to empty removes the key so an abandoned edit is a no-op).
  function setSecretInput(key: string, raw: string): void {
    if (raw === "") {
      removeValue(key);
    } else {
      setValue(key, raw);
    }
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
          {#if field.type === "secret"}
            <span
              class={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                secrets[key]?.isSet
                  ? "bg-green-600/20 text-green-400"
                  : "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]"
              }`}
              data-testid={`schema-secret-status-${key}`}
            >
              {secrets[key]?.isSet ? "Set" : "Not set"}
            </span>
          {/if}
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
        {:else if field.type === "secret"}
          {@const isSet = secrets[key]?.isSet ?? false}
          {@const pendingClear = values[key] === ""}
          <div class="flex items-center gap-2">
            <!-- NEVER prefilled: the server never sends the value, so the
                 input only ever shows what the user typed this session. -->
            <input
              id={`schema-field-${key}`}
              type="password"
              autocomplete="new-password"
              class={inputClass}
              disabled={disabled || pendingClear}
              value={typeof values[key] === "string" ? (values[key] as string) : ""}
              placeholder={isSet ? "Enter a new value to replace" : "Enter value"}
              oninput={(e) => setSecretInput(key, (e.currentTarget as HTMLInputElement).value)}
              data-testid={`schema-input-${key}`}
            />
            {#if pendingClear}
              <button
                type="button"
                {disabled}
                onclick={() => removeValue(key)}
                class="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-secondary)] disabled:opacity-50"
                data-testid={`schema-secret-undo-${key}`}
              >
                Undo
              </button>
            {:else if isSet}
              <button
                type="button"
                {disabled}
                onclick={() => setValue(key, "")}
                class="shrink-0 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/40 disabled:opacity-50"
                data-testid={`schema-secret-clear-${key}`}
              >
                Clear
              </button>
            {/if}
          </div>
          <p
            class="mt-1 text-xs text-[var(--color-text-muted)]"
            data-testid={`schema-secret-hint-${key}`}
          >
            {#if pendingClear}
              Will be cleared when you save.
            {:else if isSet}
              A value is set. It is stored encrypted and never shown again — enter a new value to replace it.
            {:else}
              Stored encrypted. Once saved, the value is never shown again.
            {/if}
          </p>
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
