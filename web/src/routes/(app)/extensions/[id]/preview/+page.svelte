<script lang="ts">
  import ExtensionBrowser from "$lib/components/extensions/ExtensionBrowser.svelte";
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{data.name} preview</title></svelte:head>
<main class="browser-page">
  <header><div><h1>{data.name}</h1><p>Isolated extension preview. Select the conversation this extension may use.</p></div><a href="/extensions">Extensions</a></header>
  <form method="GET" class="context-selector">
    <label>Conversation<select name="conversationId" value={data.conversationId ?? ""} required><option value="" disabled>Select a conversation</option>{#each data.conversations as conversation}<option value={conversation.id}>{conversation.title ?? conversation.id}</option>{/each}</select></label>
    <button type="submit">Open preview</button>
  </form>
  {#if !data.conversationId}
    <form method="POST" action="?/create" class="context-selector">
      <label>New conversation project<select name="projectId" required><option value="" disabled selected>Select a project</option>{#each data.projects as project}<option value={project.id}>{project.name}</option>{/each}</select></label>
      <button type="submit" disabled={!data.projects.length}>Create preview conversation</button>
    </form>
    <p>The extension cannot select another conversation or access your app session. Camera access requires a separate confirmation.</p>
  {:else}
    {#key `${data.binding}:${data.conversationId}:${data.nonce}`}
      <ExtensionBrowser name={data.name} binding={data.binding} nonce={data.nonce} conversationId={data.conversationId} tools={data.tools} />
    {/key}
  {/if}
</main>

<style>
  .browser-page{padding:1.5rem;max-width:96rem;margin:auto;color:var(--color-text)}
  header{display:flex;align-items:start;justify-content:space-between;gap:1rem;margin-bottom:1.5rem}
  h1{font-size:1.5rem;font-weight:600;margin:0 0 .5rem}p{color:var(--color-text-muted)}
  .context-selector{display:flex;align-items:end;gap:1rem;flex-wrap:wrap;margin:1rem 0}
  label{display:grid;gap:.5rem;min-width:16rem}select,button{padding:.65rem .9rem;border:1px solid var(--color-border);border-radius:.5rem;background:var(--color-surface);color:var(--color-text)}
  button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}a{color:var(--color-primary)}
</style>
