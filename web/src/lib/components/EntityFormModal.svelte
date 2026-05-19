<!--
  EntityFormModal — JSON-Schema-driven create/edit modal for an entity
  declaration.

  Phase 5 of the defineEntity SDK. Renders a form generated from the
  declaration's JSON Schema; submits POST (create) or PUT (update) to
  /api/extensions/[id]/entities/[type]. Server-side validation is the
  authoritative gate — the client form does basic shape checks (typed
  inputs) and surfaces server-returned issues inline on submit.

  The form is rendered recursively so nested objects (e.g.
  substack-pilot's `defaults: { titlePrefix, subtitleTemplate }`) work
  out of the box. Arrays and arbitrary additional properties are
  intentionally NOT supported in v1 — the SDK's locked schema subset
  is the contract; an extension declaring something fancier gets a
  flat "field not editable" placeholder.

  Slug input is shown for create-mode (controlled by the
  `mode === "create"` prop). For edit-mode, the slug is rendered as a
  read-only label since the SDK contract makes slugs immutable.
-->

<script lang="ts">
  import { inputClass } from "$lib/styles.js";

  interface JsonSchemaField {
    type: "object" | "string" | "number" | "boolean" | "array";
    description?: string;
    properties?: Record<string, JsonSchemaField>;
    required?: readonly string[];
    additionalProperties?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enum?: readonly string[];
    minimum?: number;
    maximum?: number;
    integer?: boolean;
    items?: JsonSchemaField;
  }

  let {
    open,
    mode,
    label,
    typeSlug,
    schema,
    slug: initialSlug = "",
    data: initialData = {},
    extensionId,
    submitting = false,
    onsubmit,
    oncancel,
  }: {
    open: boolean;
    mode: "create" | "edit";
    /** Human label ("Post Type") used in modal title + slug hint. */
    label: string;
    /** Entity declaration `type` slug — used to build the API URL. */
    typeSlug: string;
    schema: JsonSchemaField;
    slug?: string;
    data?: Record<string, unknown>;
    extensionId: string;
    submitting?: boolean;
    onsubmit: (payload: {
      slug: string;
      data: Record<string, unknown>;
    }) => void | Promise<void>;
    oncancel: () => void;
  } = $props();

  let slug = $state("");
  let values = $state<Record<string, unknown>>({});
  let serverError = $state("");
  let serverIssues = $state<Array<{ path: string; message: string }>>([]);

  // Reset state whenever the modal is (re)opened with new defaults.
  // Tracked dependencies: `open`, `initialSlug`, `initialData` —
  // Svelte's reactive graph re-runs this whenever any of them change.
  $effect(() => {
    if (open) {
      slug = initialSlug;
      values = { ...initialData };
      serverError = "";
      serverIssues = [];
    }
  });

  function setNested(
    obj: Record<string, unknown>,
    path: string[],
    value: unknown,
  ): Record<string, unknown> {
    if (path.length === 0) return obj;
    const [head, ...rest] = path;
    if (rest.length === 0) {
      return { ...obj, [head!]: value };
    }
    const child = (obj[head!] ?? {}) as Record<string, unknown>;
    return { ...obj, [head!]: setNested(child, rest, value) };
  }

  function getNested(
    obj: Record<string, unknown> | undefined,
    path: string[],
  ): unknown {
    if (!obj) return undefined;
    if (path.length === 0) return obj;
    const [head, ...rest] = path;
    const child = obj[head!];
    if (rest.length === 0) return child;
    if (!child || typeof child !== "object" || Array.isArray(child)) return undefined;
    return getNested(child as Record<string, unknown>, rest);
  }

  function updateField(path: string[], value: unknown) {
    values = setNested(values, path, value);
  }

  function coerceNumber(raw: string, integer?: boolean): number | "" {
    if (raw === "") return "";
    const n = integer ? parseInt(raw, 10) : Number(raw);
    return Number.isNaN(n) ? "" : n;
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (submitting) return;
    serverError = "";
    serverIssues = [];
    try {
      await onsubmit({ slug, data: values });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The submit callback may have already populated `serverError` via
      // the page-level fetch path; only set as fallback.
      if (!serverError) serverError = msg;
    }
  }

  function issuesForPath(path: string): string | null {
    const match = serverIssues.find((i) => i.path === path);
    return match ? match.message : null;
  }

  /** Public hook for the page wrapper to inject server-side validation
   *  failures back into the modal after a POST/PUT returns 400. */
  export function setServerIssues(
    error: string,
    issues: Array<{ path: string; message: string }>,
  ): void {
    serverError = error;
    serverIssues = issues;
  }

  type FieldEntry = [string, JsonSchemaField];

  function fieldEntries(field: JsonSchemaField): FieldEntry[] {
    return Object.entries(field.properties ?? {});
  }

  function isRequired(parent: JsonSchemaField, key: string): boolean {
    return parent.required?.includes(key) === true;
  }

  function describe(field: JsonSchemaField): string {
    return field.description ?? "";
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    role="dialog"
    aria-modal="true"
    aria-label={`${mode === "create" ? "Create" : "Edit"} ${label}`}
    data-testid={`entity-form-modal-${typeSlug}`}
  >
    <div class="w-full max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl">
      <h2 class="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
        {mode === "create" ? "Create" : "Edit"} {label}
      </h2>

      <form onsubmit={handleSubmit} class="space-y-4">
        <!-- Slug — editable on create, read-only on edit. -->
        <div>
          <label
            for={`entity-slug-${typeSlug}`}
            class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]"
          >
            Slug
          </label>
          {#if mode === "edit"}
            <p
              id={`entity-slug-${typeSlug}`}
              class="font-mono text-sm text-[var(--color-text-secondary)]"
              data-testid="entity-form-slug-readonly"
            >
              {slug}
            </p>
          {:else}
            <input
              id={`entity-slug-${typeSlug}`}
              type="text"
              class={inputClass}
              value={slug}
              required
              minlength={1}
              maxlength={64}
              pattern="^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$"
              oninput={(e) => (slug = (e.currentTarget as HTMLInputElement).value)}
              data-testid="entity-form-slug"
              disabled={submitting}
            />
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Lowercase letters, digits, and hyphens; 1–64 chars; no leading/trailing hyphen.
            </p>
          {/if}
        </div>

        <!-- Recursive field renderer (primitives + nested objects). -->
        {#each fieldEntries(schema) as [key, field] (key)}
          {@const fieldPath = [key]}
          {@const dotPath = fieldPath.join(".")}
          {@const required = isRequired(schema, key)}
          {@const issue = issuesForPath(dotPath)}
          <div data-testid={`entity-field-${dotPath}`}>
            <label
              for={`entity-field-${dotPath}`}
              class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]"
            >
              {key}{required ? " *" : ""}
            </label>
            {#if describe(field)}
              <p class="mb-1.5 text-xs text-[var(--color-text-muted)]">{describe(field)}</p>
            {/if}

            {#if field.type === "string" && field.enum}
              <select
                id={`entity-field-${dotPath}`}
                class={inputClass}
                value={(getNested(values, fieldPath) as string) ?? ""}
                onchange={(e) => updateField(fieldPath, (e.currentTarget as HTMLSelectElement).value)}
                disabled={submitting}
                data-testid={`entity-input-${dotPath}`}
              >
                <option value="" disabled>Select…</option>
                {#each field.enum as opt (opt)}
                  <option value={opt}>{opt}</option>
                {/each}
              </select>
            {:else if field.type === "string"}
              {@const isLong = (field.maxLength ?? 0) > 200}
              {#if isLong}
                <textarea
                  id={`entity-field-${dotPath}`}
                  class={inputClass + " min-h-[120px]"}
                  rows="5"
                  value={(getNested(values, fieldPath) as string) ?? ""}
                  minlength={field.minLength ?? undefined}
                  maxlength={field.maxLength ?? undefined}
                  oninput={(e) => updateField(fieldPath, (e.currentTarget as HTMLTextAreaElement).value)}
                  disabled={submitting}
                  data-testid={`entity-input-${dotPath}`}
                ></textarea>
              {:else}
                <input
                  id={`entity-field-${dotPath}`}
                  type="text"
                  class={inputClass}
                  value={(getNested(values, fieldPath) as string) ?? ""}
                  minlength={field.minLength ?? undefined}
                  maxlength={field.maxLength ?? undefined}
                  pattern={field.pattern ?? undefined}
                  oninput={(e) => updateField(fieldPath, (e.currentTarget as HTMLInputElement).value)}
                  disabled={submitting}
                  data-testid={`entity-input-${dotPath}`}
                />
              {/if}
            {:else if field.type === "number"}
              <input
                id={`entity-field-${dotPath}`}
                type="number"
                class={inputClass}
                value={(getNested(values, fieldPath) as number | "") ?? ""}
                min={field.minimum ?? undefined}
                max={field.maximum ?? undefined}
                step={field.integer ? 1 : undefined}
                oninput={(e) => updateField(fieldPath, coerceNumber((e.currentTarget as HTMLInputElement).value, field.integer))}
                disabled={submitting}
                data-testid={`entity-input-${dotPath}`}
              />
            {:else if field.type === "boolean"}
              <input
                id={`entity-field-${dotPath}`}
                type="checkbox"
                class="h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface)]"
                checked={Boolean(getNested(values, fieldPath))}
                onchange={(e) => updateField(fieldPath, (e.currentTarget as HTMLInputElement).checked)}
                disabled={submitting}
                data-testid={`entity-input-${dotPath}`}
              />
            {:else if field.type === "object" && field.properties}
              <!-- Nested object: render its primitive children inline.
                   v1 supports one level of nesting (matches substack-
                   pilot's `defaults: { titlePrefix, subtitleTemplate }`).
                   Deeper nesting renders a JSON-paste textarea as a
                   conservative fallback so the form never crashes on
                   an unexpected schema shape. -->
              <div class="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
                {#each Object.entries(field.properties) as [subKey, subField] (subKey)}
                  {@const subPath = [...fieldPath, subKey]}
                  {@const subDot = subPath.join(".")}
                  {@const subRequired = isRequired(field, subKey)}
                  <div data-testid={`entity-field-${subDot}`}>
                    <label
                      for={`entity-field-${subDot}`}
                      class="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]"
                    >
                      {subKey}{subRequired ? " *" : ""}
                    </label>
                    {#if subField.type === "string" && subField.enum}
                      <select
                        id={`entity-field-${subDot}`}
                        class={inputClass}
                        value={(getNested(values, subPath) as string) ?? ""}
                        onchange={(e) => updateField(subPath, (e.currentTarget as HTMLSelectElement).value)}
                        disabled={submitting}
                        data-testid={`entity-input-${subDot}`}
                      >
                        <option value="" disabled>Select…</option>
                        {#each subField.enum as opt (opt)}
                          <option value={opt}>{opt}</option>
                        {/each}
                      </select>
                    {:else if subField.type === "string"}
                      <input
                        id={`entity-field-${subDot}`}
                        type="text"
                        class={inputClass}
                        value={(getNested(values, subPath) as string) ?? ""}
                        minlength={subField.minLength ?? undefined}
                        maxlength={subField.maxLength ?? undefined}
                        pattern={subField.pattern ?? undefined}
                        oninput={(e) => updateField(subPath, (e.currentTarget as HTMLInputElement).value)}
                        disabled={submitting}
                        data-testid={`entity-input-${subDot}`}
                      />
                    {:else if subField.type === "number"}
                      <input
                        id={`entity-field-${subDot}`}
                        type="number"
                        class={inputClass}
                        value={(getNested(values, subPath) as number | "") ?? ""}
                        min={subField.minimum ?? undefined}
                        max={subField.maximum ?? undefined}
                        step={subField.integer ? 1 : undefined}
                        oninput={(e) => updateField(subPath, coerceNumber((e.currentTarget as HTMLInputElement).value, subField.integer))}
                        disabled={submitting}
                        data-testid={`entity-input-${subDot}`}
                      />
                    {:else if subField.type === "boolean"}
                      <input
                        id={`entity-field-${subDot}`}
                        type="checkbox"
                        class="h-4 w-4"
                        checked={Boolean(getNested(values, subPath))}
                        onchange={(e) => updateField(subPath, (e.currentTarget as HTMLInputElement).checked)}
                        disabled={submitting}
                        data-testid={`entity-input-${subDot}`}
                      />
                    {:else}
                      <p class="text-xs text-[var(--color-text-muted)]">
                        Schema type "{subField.type}" not editable in v1 (use the SDK tool directly).
                      </p>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <p class="text-xs text-[var(--color-text-muted)]">
                Schema type "{field.type}" not editable in v1 (use the SDK tool directly).
              </p>
            {/if}

            {#if issue}
              <p class="mt-1 text-xs text-red-400" data-testid={`entity-issue-${dotPath}`}>
                {issue}
              </p>
            {/if}
          </div>
        {/each}

        {#if serverError}
          <p class="text-sm text-red-400" data-testid="entity-form-error">{serverError}</p>
        {/if}

        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
            onclick={oncancel}
            disabled={submitting}
            data-testid="entity-form-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            disabled={submitting}
            data-testid="entity-form-submit"
          >
            {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </div>

        <input type="hidden" name="extensionId" value={extensionId} />
      </form>
    </div>
  </div>
{/if}
