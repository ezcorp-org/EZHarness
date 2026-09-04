<script lang="ts">
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import type { PageData } from "./$types";
  import type { InstallationState, LifecycleOperation, WorkspaceRecord } from "$server/extensions/v4/types";

  let { data }: { data: PageData } = $props();
  let state = $state<InstallationState | null>(untrack(() => data.state));
  let workspace = $state<WorkspaceRecord | null>(untrack(() => data.workspace));
  let files = $state<Record<string, string>>(untrack(() => ({ ...data.files })));
  let saved = $state(untrack(() => JSON.stringify(data.files)));
  let selected = $state(untrack(() => Object.keys(data.files).sort()[0] ?? ""));
  let newPath = $state("");
  let name = $state("my-extension");
  let busy = $state("");
  let failure = $state("");
  let notice = $state("");
  let reviewedApproval = $state("");
  const fileNames = $derived(Object.keys(files).sort());
  const dirty = $derived(JSON.stringify(files) !== saved);
  const operations = $derived(Object.values(state?.operations ?? {}).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  const releases = $derived(Object.values(state?.releases ?? {}).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  const approvals = $derived(Object.values(state?.approvals ?? {}).filter((approval) => approval.status === "pending" || approval.status === "approved"));

  $effect(() => {
    const next = data;
    untrack(() => {
      state = next.state;
      workspace = next.workspace;
      files = { ...next.files };
      saved = JSON.stringify(next.files);
      selected = Object.keys(next.files).sort()[0] ?? "";
      reviewedApproval = "";
    });
  });

  async function request<Result>(url: string, body: unknown): Promise<Result> {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? `Request failed (${response.status}).`);
    return value as Result;
  }

  function control<Result>(tool: string, input: Record<string, unknown> = {}): Promise<Result> {
    return request("/api/extensions/control", { tool, input: { ...(state ? { installationId: state.installation.id } : {}), ...input } });
  }

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = label;
    failure = "";
    notice = "";
    try { await action(); } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); } finally { busy = ""; }
  }

  async function refresh(operationId?: string): Promise<void> {
    state = await control<InstallationState>("extensions_inspect", { ...(operationId ? { operationId, waitMs: 1000 } : {}) });
  }

  async function create(): Promise<void> {
    await run("Creating", async () => {
      const result = await control<{ openUrl: string }>("extensions_workspace", { action: "create", name });
      await goto(result.openUrl, { invalidateAll: true });
    });
  }

  async function save(): Promise<void> {
    if (!workspace) return;
    const snapshot = { ...files };
    const previous = JSON.parse(saved) as Record<string, string>;
    workspace = await control<WorkspaceRecord>("extensions_workspace", { action: "edit", workspaceId: workspace.id, expectedRevision: workspace.revision, writes: snapshot, deletes: Object.keys(previous).filter((path) => !Object.hasOwn(snapshot, path)) });
    saved = JSON.stringify(snapshot);
    notice = `Saved revision ${workspace.revision}.`;
  }

  async function build(): Promise<void> {
    await run("Building", async () => {
      if (dirty) await save();
      if (!workspace) return;
      const operation = await control<LifecycleOperation>("extensions_build", { workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: crypto.randomUUID() });
      await refresh(operation.id);
      notice = "Build queued. It continues if you close this page. Refresh to see its status.";
    });
  }

  async function releaseAction(action: string, input: Record<string, unknown> = {}): Promise<void> {
    await run(action, async () => {
      await control("extensions_release", { action, ...input });
      reviewedApproval = "";
      await refresh();
    });
  }

  async function approve(approvalId: string, decision: boolean): Promise<void> {
    await run(decision ? "Approving" : "Rejecting", async () => {
      await request(`/api/extensions/releases/${state!.installation.id}/approve`, { approvalId, decision });
      reviewedApproval = "";
      await refresh();
    });
  }

  function addFile(): void {
    const path = newPath.trim();
    if (!path || Object.hasOwn(files, path)) { failure = "Enter a new file path."; return; }
    if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\\")) { failure = "Use a relative file path without parent folders."; return; }
    files = { ...files, [path]: "" };
    selected = path;
    newPath = "";
  }

  function removeFile(): void {
    const next = { ...files };
    delete next[selected];
    files = next;
    selected = Object.keys(next).sort()[0] ?? "";
  }
</script>

<svelte:head><title>Extension workspace</title></svelte:head>
<svelte:window onbeforeunload={(event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } }} />

<div class="workspace-shell">
  <header class="workspace-heading">
    <div><p class="eyebrow">Extensions / Version 4</p><h1>Extension workspace</h1><p class="muted">Build in isolation. Review the exact release. Activate only after approval.</p></div>
    {#if state}<span class="state-badge">{state.installation.status} · generation {state.installation.generation}</span>{/if}
  </header>
  {#if failure}<div role="alert" class="message failure">{failure} Your local edits remain in this page.</div>{/if}
  {#if notice}<div role="status" class="message">{notice}</div>{/if}
  {#if !state}
    <section class="panel create-panel"><h2>Start a workspace</h2><p class="muted">Includes a small SDK example and its first test.</p><label for="extension-name">Extension name</label><input id="extension-name" bind:value={name} disabled={!!busy} /><button class="primary" onclick={create} disabled={!!busy}>Create workspace</button></section>
    <section class="panel"><h2>Your installations</h2>{#each data.installations as installation (installation.id)}<a class="installation-link" href={`?installation=${encodeURIComponent(installation.id)}`}>{installation.id}<span>{installation.status}</span></a>{:else}<p class="muted">No workspaces yet.</p>{/each}</section>
  {:else}
    {#if workspace}
      <section class="panel editor-panel">
        <div class="section-heading"><h2>01 / Source</h2><span class="muted">Revision {workspace.revision} · {dirty ? "Unsaved changes" : "Saved"}</span></div>
        <div class="editor-grid"><aside class="file-tree" aria-label="Workspace files">
          {#each fileNames as path (path)}<button class:active={selected === path} onclick={() => selected = path} title={path}>{path}</button>{/each}
          <label for="new-path">Add a file</label><input id="new-path" bind:value={newPath} placeholder="src/helper.ts" disabled={!!busy} /><button onclick={addFile} disabled={!!busy}>Add file</button>
        </aside><div class="code-pane">
          {#if selected}<label class="file-heading" for="source-code">{selected}</label><textarea id="source-code" bind:value={files[selected]} spellcheck="false" disabled={!!busy} aria-label={`Source: ${selected}`}></textarea>{:else}<p class="muted">Add a file to begin.</p>{/if}
        </div></div>
        <div class="actions"><button onclick={() => run("Saving", save)} disabled={!!busy || !dirty}>Save revision</button><button class="primary" onclick={build} disabled={!!busy}>{busy === "Building" ? "Building…" : "Save and build"}</button><button class="quiet" onclick={removeFile} disabled={!!busy || !selected}>Remove selected file</button></div>
      </section>
    {/if}
    <section class="panel"><div class="section-heading"><h2>02 / Build checks</h2><button onclick={() => run("Refreshing", () => refresh())} disabled={!!busy}>Refresh status</button></div>
      {#each operations as operation (operation.id)}<article class="operation"><div class="section-heading"><code>{operation.id}</code><strong>{operation.state}</strong></div>{#each operation.diagnostics as diagnostic, index (`${operation.id}-${index}`)}<p class="diagnostic"><strong>{diagnostic.stage} / {diagnostic.code}</strong> {diagnostic.message}{#if diagnostic.file}<code>{diagnostic.file}{diagnostic.line ? `:${diagnostic.line}` : ""}</code>{/if}</p>{/each}</article>{:else}<p class="muted">Build a saved revision to get host checks and test results.</p>{/each}
    </section>
    <section class="panel"><h2>03 / Release review</h2><p class="muted">Approval applies to one tested release, permission set, runner policy, and installation generation. New code needs new approval.</p>
      {#each releases as release (release.id)}<article class="release"><div class="section-heading"><h3>{release.manifest.name} <span class="muted">{release.manifest.version}</span></h3><strong>{state.installation.activeReleaseId === release.id ? "Active" : "Verified"}</strong></div><dl><dt>Release</dt><dd><code>{release.releaseDigest}</code></dd><dt>Source</dt><dd><code>{release.sourceDigest}</code></dd><dt>Artifact</dt><dd><code>{release.artifactDigest}</code></dd><dt>Runner</dt><dd>{release.runnerProfile}<code>{release.imageDigest}</code></dd></dl><details><summary>Permissions and test evidence</summary><pre>{JSON.stringify({ permissions: release.manifest.permissions, tests: release.evidence.tests }, null, 2)}</pre></details><button disabled={!!busy} onclick={() => releaseAction("requestApproval", { releaseId: release.id, expectedActiveReleaseId: state!.installation.activeReleaseId })}>Request approval</button></article>{:else}<p class="muted">No verified releases yet. Failed builds cannot be approved.</p>{/each}
      {#each approvals as approval (approval.id)}<article class="approval"><h3>{approval.status === "approved" ? "Approved release" : "Human approval required"}</h3><p class="muted">Installation owner: {approval.principalId} · Scope: {approval.scope}</p><code>{approval.releaseDigest}</code><pre>{JSON.stringify(approval.grants.map((grant) => JSON.parse(grant)), null, 2)}</pre>
        {#if approval.status === "pending"}<label class="review-check"><input type="checkbox" checked={reviewedApproval === approval.id} onchange={(event) => reviewedApproval = event.currentTarget.checked ? approval.id : ""} disabled={!!busy || !data.canApprove} />I reviewed this release and its permissions.</label><div class="actions"><button class="primary" disabled={!!busy || !data.canApprove || reviewedApproval !== approval.id} onclick={() => approve(approval.id, true)}>Approve exact release</button><button disabled={!!busy || !data.canApprove} onclick={() => approve(approval.id, false)}>Reject</button></div>{#if !data.canApprove}<p class="muted">Sign in with a human session to approve. API keys cannot approve.</p>{/if}
        {:else}<button class="primary" disabled={!!busy} onclick={() => releaseAction("activate", { approvalId: approval.id, idempotencyKey: crypto.randomUUID() })}>Activate approved release</button>{/if}
      </article>{/each}
    </section>
    <footer class="actions"><a href="/extensions">Back to extensions</a><button disabled={!!busy || !state.installation.enabled} onclick={() => releaseAction("disable")}>Disable installation</button><span class="muted">Disabling and rollback retain extension data.</span></footer>
  {/if}
</div>

<style>
  .workspace-shell{max-width:1280px;margin:0 auto;padding:2rem;display:flex;flex-direction:column;gap:1.5rem;color:var(--text-primary)}
  .workspace-heading,.section-heading,.actions{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
  .eyebrow{font-family:var(--font-mono,monospace);font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);margin:0 0 .5rem}
  h1{font-size:1.9rem;font-weight:650;letter-spacing:-.04em;margin:0 0 .5rem}h2{font-size:1rem;margin:0;font-weight:650}h3{font-size:1rem;margin:0}
  .muted{color:var(--text-muted);font-size:.85rem}.state-badge{font-family:var(--font-mono,monospace);font-size:.75rem;border:1px solid var(--border-color,#444);padding:.5rem .75rem;border-radius:999px}
  .panel{border:1px solid var(--border-color,#444);border-radius:12px;padding:1.25rem;background:var(--bg-secondary,transparent)}.panel>h2{margin-bottom:.75rem}.create-panel{display:grid;gap:.75rem;max-width:520px}
  button,input,textarea{font:inherit}button{border:1px solid var(--border-color,#555);border-radius:6px;background:var(--bg-primary,transparent);color:inherit;padding:.5rem .8rem;cursor:pointer;font-size:.82rem}button:hover:not(:disabled){background:var(--bg-hover,#444)}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:var(--accent-color,#5c73db);color:#fff;border-color:transparent}.quiet{color:var(--text-muted)}
  input:not([type=checkbox]){width:100%;padding:.55rem;border:1px solid var(--border-color,#555);border-radius:6px;background:var(--bg-primary,transparent);color:inherit;min-width:0}label{font-size:.8rem}button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent-color,#8498ff);outline-offset:3px}
  .editor-panel{padding:0;overflow:hidden}.editor-panel>.section-heading,.editor-panel>.actions{padding:1rem 1.25rem}.editor-grid{display:grid;grid-template-columns:240px minmax(0,1fr);border-block:1px solid var(--border-color,#444);min-height:440px}.file-tree{display:flex;flex-direction:column;gap:.4rem;padding:1rem;border-right:1px solid var(--border-color,#444);min-width:0}.file-tree button{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono,monospace);border-color:transparent}.file-tree button.active{border-color:var(--accent-color,#8498ff);background:var(--bg-hover,#333)}.file-tree label{margin-top:1rem}.code-pane{display:flex;flex-direction:column;min-width:0}.file-heading{padding:.75rem 1rem;font-family:var(--font-mono,monospace);font-size:.8rem;border-bottom:1px solid var(--border-color,#444);overflow-wrap:anywhere}textarea{flex:1;min-height:400px;width:100%;resize:vertical;border:0;padding:1rem;line-height:1.6;font-family:var(--font-mono,monospace);font-size:.8rem;background:var(--bg-primary,transparent);color:inherit;tab-size:2}
  .actions{justify-content:flex-start}.message{padding:1rem;border:1px solid var(--border-color,#555);border-radius:8px;font-size:.85rem}.failure{border-color:#bc5757;color:var(--text-error,#ef9b9b)}.operation,.release,.approval{padding:1rem 0;border-top:1px solid var(--border-color,#444);margin-top:1rem}.approval{border:1px solid var(--accent-color,#8498ff);border-radius:8px;padding:1rem}.diagnostic{font-size:.85rem;white-space:pre-wrap;overflow-wrap:anywhere}code,pre{font-family:var(--font-mono,monospace);font-size:.75rem;overflow-wrap:anywhere}pre{white-space:pre-wrap;max-height:360px;overflow:auto;padding:1rem;background:var(--bg-primary,transparent);border-radius:6px}dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:.5rem;font-size:.8rem}dt{color:var(--text-muted)}dd{margin:0;overflow-wrap:anywhere}dd code{display:block}details{margin:1rem 0}summary{cursor:pointer;font-size:.85rem}.review-check{display:flex;gap:.65rem;align-items:center;margin:1rem 0}.installation-link{display:flex;justify-content:space-between;gap:1rem;padding:1rem 0;overflow-wrap:anywhere}
  @media(max-width:700px){.workspace-shell{padding:1rem}.editor-grid{grid-template-columns:1fr}.file-tree{border-right:0;border-bottom:1px solid var(--border-color,#444);max-height:240px;overflow:auto}h1{font-size:1.55rem}.state-badge{font-size:.65rem}}
</style>
