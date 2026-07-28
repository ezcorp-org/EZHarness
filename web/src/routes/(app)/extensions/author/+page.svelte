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
  import AuthorCompositionPanel from "$lib/components/extensions/AuthorCompositionPanel.svelte";
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
  // The validate endpoint returns the host's FULL acceptance gate now
  // (manifest + sandboxed smokeTest round-trip for tool/multi) — the
  // same gate Install runs — so a green result here really does mean
  // "this installs". `steps` is rendered so a failure says WHICH step.
  type GateStep = { name: string; ok: boolean; detail: string };
  let validationResult = $state<null | { ok: boolean; errors: string[]; steps: GateStep[] }>(null);
  let installError = $state<string | null>(null);
  // Save failures get their OWN banner. They used to be written into
  // `installError`, so the next install attempt overwrote them and the
  // user never learned their edit had not persisted.
  let saveError = $state<string | null>(null);
  let discardError = $state<string | null>(null);
  // Files that exist in the draft but could not be read. The loader
  // still skips them (one bad file must not 500 the editor) but it no
  // longer skips them SILENTLY — editing a draft you can only partly
  // see and then installing it is how content gets lost.
  let unreadable = $derived(data.unreadable ?? []);

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
        saveError = `Could not save ${path}: ${resp.status} ${text}. Your edit is NOT on disk — validate and install will use the previous content.`;
      } else {
        saveError = null;
      }
    } catch (e) {
      saveError = `Could not save ${path}: ${e instanceof Error ? e.message : String(e)}. Your edit is NOT on disk.`;
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

  // Phase 4 — the composition panel mutates ezcorp.config.ts (deps +
  // capability permissions). Persist the new source via the same draft
  // PUT the editor uses, and reflect it in the local file map so the
  // textarea + panel stay in sync.
  const CONFIG_FILE = "ezcorp.config.ts";
  async function onCompositionSave(nextSource: string): Promise<void> {
    files = { ...files, [CONFIG_FILE]: nextSource };
    await saveFile(CONFIG_FILE, nextSource);
  }

  async function onValidate(): Promise<void> {
    await flushPendingSave();
    validating = true;
    validationResult = null;
    try {
      // Runs the host's full acceptance gate — byte-for-byte the gate
      // Install runs (`runAuthorAcceptanceGate`).
      const resp = await fetch(`/api/extensions/author/draft/${data.draft.id}/validate`, {
        method: "POST",
      });
      if (!resp.ok) {
        const text = await resp.text();
        validationResult = { ok: false, errors: [`HTTP ${resp.status}: ${text}`], steps: [] };
        return;
      }
      const json = await resp.json();
      validationResult = {
        ok: json.ok === true,
        errors: Array.isArray(json.errors) ? json.errors : [],
        steps: Array.isArray(json.steps) ? json.steps : [],
      };
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
    discardError = null;
    try {
      // Check the response. Navigating away regardless told the user
      // "discarded" for a draft a 500 had left fully intact.
      const resp = await fetch(`/api/extensions/author/draft/${data.draft.id}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        const text = await resp.text();
        discardError = `Discard failed (${resp.status}): ${text || "the draft is still here."}`;
        return;
      }
      await goto("/extensions");
    } catch (e) {
      discardError = `Discard failed: ${e instanceof Error ? e.message : String(e)}`;
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

  {#if unreadable.length > 0}
    <section class="status err" data-testid="unreadable-files">
      <p>
        {unreadable.length} file{unreadable.length === 1 ? "" : "s"} in this draft could not be read and
        {unreadable.length === 1 ? "is" : "are"} NOT shown below. Installing now would install content you cannot see here.
      </p>
      <ul>
        {#each unreadable as u (u.name)}
          <li><code>{u.name}</code> — {u.error}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if files[CONFIG_FILE] !== undefined}
    <AuthorCompositionPanel source={files[CONFIG_FILE]} onsave={onCompositionSave} />
  {/if}

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
        <p>Acceptance gate passed. This draft is ready to install.</p>
      {:else}
        <p>Acceptance gate failed:</p>
        <ul>
          {#each validationResult.errors as err, i (i)}
            <li>{err}</li>
          {/each}
        </ul>
      {/if}
      {#if validationResult.steps.length > 0}
        <ul class="steps" data-testid="validation-steps">
          {#each validationResult.steps as step (step.name)}
            <li class:step-ok={step.ok} class:step-err={!step.ok} data-testid="validation-step-{step.name}">
              <span class="step-mark" aria-hidden="true">{step.ok ? "✓" : "✗"}</span>
              <span class="step-name">{step.name}</span>
              <span class="step-detail">{step.detail}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if saveError}
    <section class="status err" data-testid="save-error">
      <p>{saveError}</p>
    </section>
  {/if}

  {#if installError}
    <section class="status err" data-testid="install-error">
      <p>{installError}</p>
    </section>
  {/if}

  {#if discardError}
    <section class="status err" data-testid="discard-error">
      <p>{discardError}</p>
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

  .steps {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
  }

  .steps li {
    display: grid;
    grid-template-columns: 1rem 10rem 1fr;
    gap: 0.5rem;
    align-items: baseline;
  }

  .step-mark {
    font-weight: 700;
  }

  .step-ok .step-mark {
    color: var(--color-ok, #059669);
  }

  .step-err .step-mark {
    color: var(--color-err, #dc2626);
  }

  .step-name {
    font-family: var(--font-mono, monospace);
    color: var(--text-muted, #888);
  }

  .step-detail {
    overflow-wrap: anywhere;
  }

  .empty {
    color: var(--text-muted, #888);
  }
</style>
