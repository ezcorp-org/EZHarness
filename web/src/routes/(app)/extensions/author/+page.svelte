<script lang="ts">
  // Editable preview page for an extension-author draft.
  //
  // v1 UX: file tree on the left, plain `<textarea>` on the right with
  // monospace styling. No CodeMirror / Monaco — those pull a heavy
  // editor lib that's not justified for v1. Validate / Install /
  // Discard buttons hit dedicated API endpoints.
  //
  // The page receives `{ draft, files }` from `+page.server.ts`. Edits
  // are saved file-by-file via `PUT /api/extensions/author/draft/[id]`
  // — the on-disk file map is the source of truth, no client-side
  // merge logic.
  import { goto } from "$app/navigation";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // Reactive copy of the file map. Keys are sorted for stable display.
  let files = $state<Record<string, string>>({ ...data.files });
  let fileNames = $derived(Object.keys(files).sort());
  let selected = $state<string>(fileNames[0] ?? "");
  let saving = $state(false);
  let validating = $state(false);
  let installing = $state(false);
  let discarding = $state(false);
  let validationResult = $state<null | { ok: boolean; errors: string[] }>(null);
  let installError = $state<string | null>(null);

  $effect(() => {
    // Pick the first file when the selection becomes invalid (e.g.
    // initial mount, or after the file list shrinks).
    if (!fileNames.includes(selected) && fileNames.length > 0) {
      selected = fileNames[0]!;
    }
  });

  async function saveFile(path: string, content: string): Promise<void> {
    saving = true;
    try {
      const resp = await fetch(`/api/extensions/author/draft/${data.draft.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        installError = `Save failed: ${resp.status} ${text}`;
      }
    } finally {
      saving = false;
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function onEdit(): void {
    // Debounced save: 600ms after last keystroke. Source of truth is
    // the on-disk file, so mid-typing crashes are recoverable on
    // reload.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveFile(selected, files[selected] ?? "");
    }, 600);
  }

  /**
   * Flush a pending debounced save before running Validate / Install /
   * Discard. Without this, a 600ms timer fired mid-action could
   * overwrite a just-edited file AFTER the action's server roundtrip
   * read it — see N2 in the fix-loop brief.
   */
  async function flushPendingSave(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await saveFile(selected, files[selected] ?? "");
    }
  }

  async function onValidate(): Promise<void> {
    await flushPendingSave();
    validating = true;
    validationResult = null;
    try {
      // The validate endpoint is a wrapper around the host's
      // `validateManifestV2` — same gate the install endpoint runs.
      const resp = await fetch(`/api/extensions/author/draft/${data.draft.id}/validate`, {
        method: "POST",
      });
      if (!resp.ok) {
        const text = await resp.text();
        validationResult = { ok: false, errors: [`HTTP ${resp.status}: ${text}`] };
        return;
      }
      const json = await resp.json();
      validationResult = { ok: json.ok === true, errors: Array.isArray(json.errors) ? json.errors : [] };
    } finally {
      validating = false;
    }
  }

  async function onInstall(): Promise<void> {
    await flushPendingSave();
    installing = true;
    installError = null;
    try {
      const resp = await fetch(`/api/extensions/author/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: data.draft.id }),
      });
      const text = await resp.text();
      let parsed: { extensionId?: string; redirectUrl?: string; message?: string; errors?: string[] };
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text };
      }
      if (!resp.ok) {
        const detail = parsed.errors ? parsed.errors.join("; ") : parsed.message ?? text;
        installError = `Install failed (${resp.status}): ${detail}`;
        return;
      }
      if (parsed.redirectUrl) {
        await goto(parsed.redirectUrl);
      }
    } finally {
      installing = false;
    }
  }

  async function onDiscard(): Promise<void> {
    if (!confirm("Discard this draft? This cannot be undone.")) return;
    // Cancel any pending save — the dir is about to be removed.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    discarding = true;
    try {
      await fetch(`/api/extensions/author/draft/${data.draft.id}`, { method: "DELETE" });
      await goto("/extensions");
    } finally {
      discarding = false;
    }
  }
</script>

<svelte:head>
  <title>Extension Author Preview</title>
</svelte:head>

<div class="container">
  <header>
    <h1>Extension Author Preview</h1>
    <p class="meta">
      Draft <code>{data.draft.id}</code>
      {#if data.draft.payload && typeof data.draft.payload === "object"}
        {@const p = data.draft.payload as Record<string, unknown>}
        {#if typeof p.name === "string"} — <strong>{p.name}</strong>{/if}
        {#if typeof p.type === "string"} ({p.type}){/if}
      {/if}
    </p>
  </header>

  <div class="editor">
    <aside class="file-tree" data-testid="file-tree">
      <h2>Files</h2>
      <ul>
        {#each fileNames as name (name)}
          <li>
            <button
              type="button"
              class:active={name === selected}
              onclick={() => (selected = name)}
              data-testid="file-tab-{name}"
            >
              {name}
            </button>
          </li>
        {/each}
      </ul>
    </aside>

    <main class="code">
      {#if selected}
        <label class="file-header">
          <span>{selected}</span>
          {#if saving}<span class="saving">saving…</span>{/if}
        </label>
        <textarea
          bind:value={files[selected]}
          oninput={onEdit}
          spellcheck="false"
          data-testid="file-content"
        ></textarea>
      {:else}
        <p class="empty">No files in this draft.</p>
      {/if}
    </main>
  </div>

  <footer class="actions">
    <button type="button" onclick={onValidate} disabled={validating} data-testid="validate-btn">
      {validating ? "Validating…" : "Validate"}
    </button>
    <button type="button" onclick={onInstall} disabled={installing} data-testid="install-btn">
      {installing ? "Installing…" : "Install"}
    </button>
    <button type="button" onclick={onDiscard} disabled={discarding} data-testid="discard-btn">
      {discarding ? "Discarding…" : "Discard"}
    </button>
  </footer>

  {#if validationResult}
    <section class="status" data-testid="validation-status" class:ok={validationResult.ok} class:err={!validationResult.ok}>
      {#if validationResult.ok}
        <p>Manifest valid. Ready to install.</p>
      {:else}
        <p>Validation failed:</p>
        <ul>
          {#each validationResult.errors as err, i (i)}
            <li>{err}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if installError}
    <section class="status err" data-testid="install-error">
      <p>{installError}</p>
    </section>
  {/if}
</div>

<style>
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.4rem;
  }

  .meta {
    margin: 0;
    color: var(--text-muted, #888);
    font-size: 0.9rem;
  }

  .editor {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 1rem;
    min-height: 480px;
  }

  .file-tree {
    border-right: 1px solid var(--border-color, #ddd);
    padding-right: 0.75rem;
  }

  .file-tree h2 {
    font-size: 0.9rem;
    margin: 0 0 0.5rem;
    text-transform: uppercase;
    color: var(--text-muted, #888);
  }

  .file-tree ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .file-tree li {
    margin-bottom: 0.25rem;
  }

  .file-tree button {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    font-family: var(--font-mono, monospace);
    font-size: 0.85rem;
  }

  .file-tree button:hover {
    background: var(--bg-hover, #f3f4f6);
  }

  .file-tree button.active {
    background: var(--bg-active, #e7f0ff);
    border-color: var(--border-active, #b3cdef);
  }

  .code {
    display: flex;
    flex-direction: column;
  }

  .file-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.25rem 0.5rem;
    color: var(--text-muted, #888);
    font-size: 0.85rem;
  }

  .saving {
    font-style: italic;
  }

  .code textarea {
    flex: 1;
    width: 100%;
    min-height: 420px;
    font-family: var(--font-mono, monospace);
    font-size: 0.85rem;
    line-height: 1.4;
    padding: 0.5rem;
    border: 1px solid var(--border-color, #ddd);
    border-radius: 4px;
    resize: vertical;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .actions button {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border-color, #ddd);
    border-radius: 4px;
    background: var(--bg-button, #fff);
    cursor: pointer;
  }

  .actions button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .status {
    padding: 0.75rem 1rem;
    border-radius: 4px;
    border: 1px solid var(--border-color, #ddd);
  }

  .status.ok {
    background: var(--bg-ok, #ecfdf5);
    border-color: var(--border-ok, #a7f3d0);
  }

  .status.err {
    background: var(--bg-err, #fef2f2);
    border-color: var(--border-err, #fca5a5);
  }

  .empty {
    color: var(--text-muted, #888);
  }
</style>
