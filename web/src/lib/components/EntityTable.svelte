<!--
  EntityTable — auto-generated per-entity-type table for the extension
  detail page.

  Phase 5 of the defineEntity SDK. Lists existing records, surfaces
  schema-drift warnings, and drives create/edit/delete via a paired
  EntityFormModal. The whole component is self-contained: pass it an
  extension id + a declaration, and it handles its own fetch loop +
  modal state.

  Visual hierarchy mirrors the SettingsPanel sibling:
    - section header (label + "+ Create")
    - table (slug, name (when present), preview, actions)
    - empty state
    - drift banner for any row whose body fails the current schema
-->

<script lang="ts">
  import EntityFormModal from "./EntityFormModal.svelte";

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

  interface EntityDeclaration {
    type: string;
    label: string;
    pluralLabel: string;
    scope?: "user" | "project" | "conversation";
    cascadeOnUninstall?: boolean;
    schema: JsonSchemaField;
    preview?: string;
  }

  interface EntityRecordView {
    slug: string;
    data: Record<string, unknown>;
    _validationWarning?: {
      code: "SCHEMA_DRIFT";
      issues: Array<{ path: string; message: string }>;
    };
  }

  let {
    extensionId,
    decl,
  }: {
    extensionId: string;
    decl: EntityDeclaration;
  } = $props();

  let records = $state<EntityRecordView[]>([]);
  // Sorted view used in the template — building a slice avoids mutating
  // the source array (Svelte's $state mutation guard forbids in-place
  // sort in derived contexts).
  const sortedRecords = $derived(
    [...records].sort((a, b) => a.slug.localeCompare(b.slug)),
  );
  let loading = $state(true);
  let error = $state("");
  let modal = $state<
    | null
    | {
        mode: "create" | "edit";
        slug: string;
        data: Record<string, unknown>;
      }
  >(null);
  let submitting = $state(false);
  let formRef = $state<{
    setServerIssues: (
      err: string,
      issues: Array<{ path: string; message: string }>,
    ) => void;
  } | null>(null);
  let deletingSlug = $state<string | null>(null);

  const baseUrl = $derived(
    `/api/extensions/${extensionId}/entities/${decl.type}`,
  );

  async function load() {
    loading = true;
    error = "";
    try {
      const res = await fetch(baseUrl);
      if (!res.ok) {
        error = `Failed to load (HTTP ${res.status})`;
        records = [];
        return;
      }
      const body = (await res.json()) as { items: EntityRecordView[] };
      records = body.items;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function previewFor(rec: EntityRecordView): string {
    const tmpl = decl.preview;
    if (!tmpl) return summarize(rec.data);
    return tmpl.replace(/\{([^}]+)\}/g, (_, raw: string) => {
      const path = raw.trim();
      if (path === "slug") return rec.slug;
      const parts = path.split(".");
      let v: unknown = rec.data;
      for (const p of parts) {
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          return `{${path}}`;
        }
        v = (v as Record<string, unknown>)[p];
      }
      return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    });
  }

  function summarize(data: Record<string, unknown>): string {
    const keys = Object.keys(data);
    if (keys.length === 0) return "";
    const first = keys[0]!;
    const v = data[first];
    return `${first}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
  }

  function openCreate() {
    modal = { mode: "create", slug: "", data: {} };
  }

  function openEdit(rec: EntityRecordView) {
    modal = { mode: "edit", slug: rec.slug, data: { ...rec.data } };
  }

  async function handleSubmit(payload: {
    slug: string;
    data: Record<string, unknown>;
  }) {
    if (!modal) return;
    submitting = true;
    try {
      const url =
        modal.mode === "create"
          ? baseUrl
          : `${baseUrl}/${encodeURIComponent(payload.slug)}`;
      const method = modal.mode === "create" ? "POST" : "PUT";
      const body =
        modal.mode === "create"
          ? JSON.stringify({ slug: payload.slug, data: payload.data })
          : JSON.stringify({ data: payload.data });
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: Array<{ path: string; message: string }>;
        };
        formRef?.setServerIssues(
          errBody.error ?? `Failed (HTTP ${res.status})`,
          errBody.issues ?? [],
        );
        return;
      }
      modal = null;
      await load();
    } finally {
      submitting = false;
    }
  }

  async function handleDelete(slug: string) {
    if (!confirm(`Delete ${decl.label} "${slug}"? This cannot be undone.`)) {
      return;
    }
    deletingSlug = slug;
    try {
      const res = await fetch(`${baseUrl}/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        error = `Delete failed (HTTP ${res.status})`;
        return;
      }
      await load();
    } finally {
      deletingSlug = null;
    }
  }
</script>

<section
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
  data-testid={`entity-table-section-${decl.type}`}
>
  <div class="mb-3 flex items-center justify-between">
    <div>
      <h3 class="text-sm font-medium text-[var(--color-text-secondary)]">
        {decl.pluralLabel}
      </h3>
      {#if decl.schema.description}
        <p class="text-xs text-[var(--color-text-muted)]">{decl.schema.description}</p>
      {/if}
    </div>
    <button
      type="button"
      class="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500"
      onclick={openCreate}
      data-testid={`entity-create-${decl.type}`}
    >
      + Create
    </button>
  </div>

  {#if error}
    <p class="mb-3 text-xs text-red-400" data-testid={`entity-error-${decl.type}`}>{error}</p>
  {/if}

  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
  {:else if records.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid={`entity-empty-${decl.type}`}>
      No {decl.pluralLabel.toLowerCase()} yet. Click <strong>+ Create</strong> to add one.
    </p>
  {:else}
    <table class="w-full text-sm" data-testid={`entity-rows-${decl.type}`}>
      <thead>
        <tr class="text-left text-xs text-[var(--color-text-muted)]">
          <th class="pb-2 pr-3 font-medium">Slug</th>
          <th class="pb-2 pr-3 font-medium">Preview</th>
          <th class="pb-2 text-right font-medium">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each sortedRecords as rec (rec.slug)}
          <tr
            class="border-t border-[var(--color-border)]"
            data-testid={`entity-row-${decl.type}-${rec.slug}`}
          >
            <td class="py-2 pr-3 font-mono text-xs text-[var(--color-text-secondary)]">
              {rec.slug}
              {#if rec._validationWarning}
                <span
                  class="ml-1 rounded bg-amber-900/40 px-1 py-0.5 text-[10px] text-amber-300"
                  title={rec._validationWarning.issues.map((i) => `${i.path}: ${i.message}`).join("\n")}
                  data-testid={`entity-drift-${decl.type}-${rec.slug}`}
                >
                  drift
                </span>
              {/if}
            </td>
            <td class="py-2 pr-3 text-[var(--color-text-secondary)]">
              <span class="line-clamp-2">{previewFor(rec)}</span>
            </td>
            <td class="py-2 text-right">
              <button
                type="button"
                class="mr-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
                onclick={() => openEdit(rec)}
                data-testid={`entity-edit-${decl.type}-${rec.slug}`}
              >
                Edit
              </button>
              <button
                type="button"
                class="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20"
                onclick={() => handleDelete(rec.slug)}
                disabled={deletingSlug === rec.slug}
                data-testid={`entity-delete-${decl.type}-${rec.slug}`}
              >
                {deletingSlug === rec.slug ? "Deleting…" : "Delete"}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

{#if modal}
  <EntityFormModal
    bind:this={formRef}
    open={true}
    mode={modal.mode}
    label={decl.label}
    typeSlug={decl.type}
    schema={decl.schema}
    slug={modal.slug}
    data={modal.data}
    extensionId={extensionId}
    submitting={submitting}
    onsubmit={handleSubmit}
    oncancel={() => (modal = null)}
  />
{/if}
