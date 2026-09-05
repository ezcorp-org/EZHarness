<script lang="ts">
  import { enhance } from "$app/forms";
  import type { PageProps } from "./$types";
  let { data, form }: PageProps = $props();
  let reviewed = $state(false);
  let pending = $state(false);
</script>

<svelte:head><title>Review project changes · EZCorp</title></svelte:head>

<main class="mx-auto max-w-3xl space-y-6 p-6">
  <header class="space-y-2">
    <p class="text-sm text-[var(--color-text-muted)]">Human approval required</p>
    <h1 class="text-2xl font-semibold">Review project changes</h1>
    <p>This host-owned review permits only the listed GitHub action. The extension cannot approve it.</p>
  </header>
  <section class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-5">
    <h2 class="text-lg font-medium">{data.proposal.repository} #{data.proposal.number}</h2>
    <a class="underline" href={`https://github.com/${data.proposal.repository}/pull/${data.proposal.number}`} target="_blank" rel="noreferrer">View the pull request and diff on GitHub</a>
    <dl class="space-y-2 text-sm">
      <div><dt class="font-medium">Exact head commit</dt><dd class="break-all font-mono">{data.proposal.snapshot.head}</dd></div>
      <div><dt class="font-medium">Base commit</dt><dd class="break-all font-mono">{data.proposal.snapshot.base}</dd></div>
      <div><dt class="font-medium">Requested action</dt><dd>{data.proposal.merge ? "Mark ready, add the approval comment, and squash merge." : "Mark ready and add the approval comment. Do not merge."}</dd></div>
      <div><dt class="font-medium">Status</dt><dd>{data.state}</dd></div>
    </dl>
    <details open><summary class="font-medium">Changed and renamed files ({data.proposal.snapshot.files.length})</summary><ul class="mt-3 max-h-72 overflow-auto text-sm">{#each data.proposal.snapshot.files as path}<li class="break-all font-mono">{path}</li>{/each}</ul></details>
  </section>
  {#if form?.message}<p role="status" class="rounded-lg border border-[var(--color-border)] p-4">{form.message}</p>{/if}
  {#if data.state === "proposed"}
    <form method="POST" use:enhance={() => { pending = true; return async ({ update }) => { await update(); pending = false; reviewed = false; }; }} class="space-y-4">
      <input type="hidden" name="digest" value={data.proposal.snapshot.digest} />
      <label class="flex items-start gap-3"><input type="checkbox" name="reviewed" value="yes" bind:checked={reviewed} class="mt-1" /><span>I reviewed this exact commit, the file list, and the GitHub diff.</span></label>
      <div class="flex flex-wrap gap-3">
        <button name="decision" value="finalize" disabled={!reviewed || pending} class="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-white disabled:opacity-40">{data.proposal.merge ? "Approve and merge" : "Approve and mark ready"}</button>
        <button name="decision" value="close" disabled={!reviewed || pending} class="rounded-lg border border-[var(--color-border)] px-4 py-2 disabled:opacity-40">Close this pull request</button>
        <button name="decision" value="reject" disabled={!reviewed || pending} class="rounded-lg border border-[var(--color-border)] px-4 py-2 disabled:opacity-40">Reject without changes</button>
      </div>
      <p class="text-sm text-[var(--color-text-muted)]">Approval expires after 24 hours. Changes to the release, project binding, or pull request require a new review. Failed or interrupted writes are not retried.</p>
    </form>
  {:else}
    <p>{data.state === "failed" || data.state === "executing" ? "Verify GitHub before proceeding. The operation may have partial effects and will not be retried." : "This decision is final. Return to the extension dashboard to update its loop status."}</p>
  {/if}
</main>
