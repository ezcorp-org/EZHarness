<script lang="ts">
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();
  let target = $state(untrack(() => data.selectedTarget || (data.canCreate ? "" : data.targets[0]?.id ?? "")));
  let kind = $state("github");
  let identity = $state("");
  let ref = $state("");
  let directory = $state("");
  let projectId = $state("");
  let busy = $state(false);
  let failure = $state("");
  const labels: Record<string, string> = { github: "GitHub repository", marketplace: "Marketplace version ID", local: "Source directory", bundled: "Bundled extension name" };
  const examples: Record<string, string> = { github: "owner/repository", marketplace: "Exact published version identifier", local: "/approved/root/my-extension", bundled: "scratchpad" };
  const identityFields: Record<string, string> = { github: "repository", marketplace: "versionId", local: "path", bundled: "name" };
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    failure = "";
    try {
      const input = { kind, [identityFields[kind]!]: identity.trim(), ...(target ? { targetInstallationId: target } : {}), ...(kind === "github" ? { ...(ref.trim() ? { ref: ref.trim() } : {}), ...(directory.trim() ? { directory: directory.trim() } : {}), ...(projectId ? { projectId } : {}) } : {}) };
      const response = await fetch("/api/extensions/import-source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "Source import failed. Check the source and your access.");
      if (typeof result.installation?.id !== "string" || typeof result.workspace?.id !== "string") throw new Error("The server did not return a source workspace.");
      await goto(`/extensions/author?installation=${encodeURIComponent(result.installation.id)}&workspace=${encodeURIComponent(result.workspace.id)}`);
    } catch (error) { failure = error instanceof Error ? error.message : "Source import failed."; }
    finally { busy = false; }
  }
</script>

<svelte:head><title>Import extension source · EZCorp</title></svelte:head>
<section class="source-import">
  <header>
    <a href="/extensions" class="back">← Extensions</a>
    <p class="eyebrow">SOURCE → BUILD → REVIEW</p>
    <h1>Import extension source</h1>
    <p class="intro">Prepare a new candidate. Keep active code and permissions unchanged.</p>
  </header>
  <div class="import-grid">
    <form onsubmit={submit} aria-label="Import extension source">
      <label for="source-target">Installation</label>
      <select id="source-target" bind:value={target} disabled={busy} required={!data.canCreate}>
        {#if data.canCreate}<option value="">Create a new installation</option>{/if}
        {#each data.targets as installation (installation.id)}<option value={installation.id}>{installation.name}</option>{/each}
      </select>
      <p class="hint">{target ? "Keep this installation's ID, data, and links. The new source still needs review." : "New installations start disabled with no granted permissions."}</p>
      <label for="source-kind">Source type</label>
      <select id="source-kind" bind:value={kind} disabled={busy}>
        <option value="github">GitHub repository</option><option value="marketplace">Marketplace release</option>
        {#if data.canCreate}<option value="local">Host source directory</option><option value="bundled">Bundled extension</option>{/if}
      </select>
      <label for="source-identity">{labels[kind]}</label>
      <input id="source-identity" bind:value={identity} placeholder={examples[kind]} disabled={busy} required maxlength="4096" autocomplete="off" />
      {#if kind === "github"}
        <div class="field-pair">
          <div><label for="source-ref">Branch, tag, or commit <span>optional</span></label><input id="source-ref" bind:value={ref} placeholder="Repository default" disabled={busy} maxlength="200" /></div>
          <div><label for="source-directory">Subdirectory <span>optional</span></label><input id="source-directory" bind:value={directory} placeholder="Repository root" disabled={busy} maxlength="4096" /></div>
        </div>
        <label for="source-project">Private repository access</label>
        <select id="source-project" bind:value={projectId} disabled={busy}><option value="">Public source — no credential</option>{#each data.projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}</select>
        <p class="hint">For private source, select a project with this exact GitHub origin. Its saved credential stays on the host.</p>
      {/if}
      {#if failure}<p role="alert" class="failure">{failure}</p>{/if}
      {#if !data.canCreate && data.targets.length === 0}<p class="hint">You do not own an installation yet. Ask an administrator to create one.</p>{/if}
      <button type="submit" disabled={busy || !identity.trim() || (!data.canCreate && !target)}>{busy ? "Collecting source…" : "Import and build candidate"}</button>
      <p class="hint">Import does not approve, activate, or replace an active release.</p>
    </form>
    <aside aria-label="Import review steps">
      <h2>One source. Three checks.</h2>
      <ol>
        <li><span class="step-number">01</span><div><h3>Collect</h3><p>Save a bounded source snapshot. Never run its configuration on the host.</p></div></li>
        <li><span class="step-number">02</span><div><h3>Build in isolation</h3><p>Compile the exact revision. Check tests, metadata, and declared capabilities.</p></div></li>
        <li><span class="step-number">03</span><div><h3>Review before activation</h3><p>A human administrator approves the exact verified release and permissions.</p></div></li>
      </ol>
      <p class="boundary">No pasted tokens. No automatic grants. No name-based takeover.</p>
    </aside>
  </div>
</section>

<style>
  .source-import { max-width: 1080px; margin: 0 auto; padding: 1rem 0 3rem; color: var(--color-text-primary); }
  .back { color: var(--color-text-secondary); font-size: .85rem; }
  .eyebrow { margin-top: 2rem; color: var(--color-text-secondary); font-size: .7rem; letter-spacing: .14em; }
  h1 { margin: .5rem 0; font-size: clamp(1.7rem, 4vw, 2.5rem); font-weight: 650; letter-spacing: -.035em; }
  .intro { color: var(--color-text-secondary); max-width: 40rem; line-height: 1.6; }
  .import-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(250px, 1fr); gap: 2rem; margin-top: 2rem; align-items: start; }
  form, aside { border: 1px solid var(--color-border); border-radius: 12px; padding: 1.5rem; background: var(--color-bg-secondary); min-width: 0; }
  label { display: block; margin: 1.1rem 0 .45rem; font-size: .82rem; font-weight: 600; }
  form > label:first-child { margin-top: 0; }
  label span { color: var(--color-text-secondary); font-size: .7rem; font-weight: 400; }
  input, select { width: 100%; box-sizing: border-box; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg-primary); color: var(--color-text-primary); padding: .7rem; font-size: .85rem; }
  input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid #60a5fa; outline-offset: 3px; }
  .hint { color: var(--color-text-secondary); font-size: .75rem; line-height: 1.5; margin: .55rem 0 0; }
  .field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
  button { margin-top: 1.5rem; background: #2563eb; color: white; border: 1px solid #60a5fa; border-radius: 6px; padding: .75rem 1rem; font-size: .85rem; font-weight: 600; width: 100%; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .failure { padding: .8rem; border: 1px solid #ef4444; border-radius: 6px; color: #fca5a5; margin-top: 1rem; overflow-wrap: anywhere; }
  h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1.5rem; }
  ol { list-style: none; padding: 0; margin: 0; }
  li { display: flex; gap: 1rem; padding: 0 0 1.7rem; }
  .step-number { font-size: .75rem; font-variant-numeric: tabular-nums; color: #60a5fa; padding-top: .2rem; }
  h3 { font-size: .85rem; font-weight: 600; margin-bottom: .4rem; }
  li p, .boundary { color: var(--color-text-secondary); font-size: .8rem; line-height: 1.6; }
  .boundary { border-top: 1px solid var(--color-border); padding-top: 1rem; }
  @media (max-width: 760px) { .import-grid { grid-template-columns: 1fr; } .field-pair { grid-template-columns: 1fr; gap: 0; } form, aside { padding: 1.1rem; } }
</style>
