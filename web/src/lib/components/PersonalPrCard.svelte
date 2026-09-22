<script lang="ts">
	import type { PersonalPrView } from "$lib/personal-pr.js";
	import { trustedGithubPrUrl } from "$lib/personal-pr.js";

	let { runId, onreview, refreshKey = 0 }: {
		runId: string | null;
		onreview: (view: PersonalPrView) => void;
		refreshKey?: number;
	} = $props();

	let view = $state<PersonalPrView | null>(null);
	let busy = $state(false);
	let error = $state("");
	let githubSettingsHref = $derived.by(() => {
		const query = new URLSearchParams();
		if (view?.repository) query.set("repositoryId", String(view.repository.id));
		if (view?.proposalId) query.set("review", view.proposalId);
		return `/settings/github${query.size ? `?${query}` : ""}`;
	});

	$effect(() => {
		const id = runId;
		void refreshKey;
		view = null;
		error = "";
		if (!id) return;
		const controller = new AbortController();
		fetch(`/api/github/personal-prs/runs/${encodeURIComponent(id)}`, { signal: controller.signal })
			.then(async (response) => {
				if (response.status === 404) return null;
				if (!response.ok) throw new Error("Could not load pull request status");
				return response.json() as Promise<PersonalPrView>;
			})
			.then((result) => { if (!controller.signal.aborted) view = result; })
			.catch(() => { if (!controller.signal.aborted) error = "Could not load pull request status"; });
		return () => controller.abort();
	});

	async function review() {
		if (!runId || !view || busy) return;
		busy = true;
		error = "";
		try {
			const response = await fetch(`/api/github/personal-prs/runs/${encodeURIComponent(runId)}/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? "Could not prepare pull request");
			view = result as PersonalPrView;
			onreview(view);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not prepare pull request";
		} finally {
			busy = false;
		}
	}
</script>

{#if view && view.state !== "no_changes"}
	<section class="mx-4 my-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4 sm:mx-12" data-testid="personal-pr-card" aria-label="Pull request">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h3 class="font-semibold text-[var(--color-text-primary)]">{view.state === "created" ? "Draft PR created" : view.state === "working" ? "Preparing PR" : "PR ready"}</h3>
				<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{view.repository?.fullName ?? "Your private sandbox"}{view.files?.length ? ` · ${view.files.length} files` : ""}{view.checks?.length ? ` · ${view.checks.every((check) => check.result === "passed") ? "checks passed" : "check warning"}` : ""}</p>
			</div>
			{#if view.state === "ready" || view.state === "reviewing"}
				<div class="flex flex-wrap gap-2"><button class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)]" onclick={() => onreview(view!)}>View diff</button><button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy} onclick={review}>Review &amp; create draft PR</button></div>
			{:else if view.state === "created" && trustedGithubPrUrl(view.prUrl)}
				<a class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)]" href={trustedGithubPrUrl(view.prUrl) ?? undefined} target="_blank" rel="noopener noreferrer">View PR on GitHub</a>
			{:else if view.state === "blocked"}
				<a class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)]" href={githubSettingsHref}>Manage GitHub access</a>
			{/if}
		</div>
		{#if view.state === "ready" || view.state === "reviewing"}<p class="mt-2 text-xs text-[var(--color-text-muted)]">Nothing pushed yet.</p>{/if}
		{#if view.blockReason}<p class="mt-2 text-sm text-[var(--color-text-secondary)]" role="status">{view.blockReason}</p>{/if}
		{#if view.state === "stale" || view.state === "failed"}<p class="mt-2 text-sm text-red-700 dark:text-red-300" role="status">This draft needs a new review before GitHub can be updated.</p>{/if}
		{#if error}<p class="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>{/if}
	</section>
{:else if error}
	<p class="mx-4 my-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>
{/if}
