<script lang="ts">
	import type { PersonalPrView } from "$lib/personal-pr.js";
	import { fileCountLabel, personalPrReason, trustedGithubPrUrl } from "$lib/personal-pr.js";

	let { runId, onreview, refreshKey = 0 }: {
		runId: string | null;
		onreview: (view: PersonalPrView) => void;
		refreshKey?: number;
	} = $props();

	let view = $state<PersonalPrView | null>(null);
	let busy = $state(false);
	let error = $state("");
	let preparedNoChanges = $state(false);
	let canPrepare = $derived(view?.state === "working" && view.blockReason === "review_not_prepared");
	let title = $derived.by(() => {
		switch (view?.state) {
			case "working": return canPrepare ? "Changes ready for review" : "Preparing PR review";
			case "ready": case "reviewing": return "PR ready for review";
			case "creating": return "Creating draft PR";
			case "created": return "Draft PR created";
			case "blocked": return "PR review blocked";
			case "stale": return "PR review expired";
			case "failed": return "Draft PR creation failed";
			case "no_changes": return "No file changes to review";
			default: return "Pull request";
		}
	});
	let reason = $derived(personalPrReason(view?.blockReason));
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
		preparedNoChanges = false;
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
			preparedNoChanges = view.state === "no_changes";
			if (view.state === "ready" || view.state === "reviewing") onreview(view);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not prepare pull request";
		} finally {
			busy = false;
		}
	}
</script>

{#if view && (view.state !== "no_changes" || preparedNoChanges)}
	<section class="mx-4 my-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4 sm:mx-12" data-testid="personal-pr-card" aria-label="Pull request">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h3 class="font-semibold text-[var(--color-text-primary)]">{title}</h3>
					<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{view.repository?.fullName ?? "Your private sandbox"}{view.files?.length ? ` · ${fileCountLabel(view.files.length)}` : ""}{view.state === "ready" || view.state === "reviewing" ? ` · ${view.checks?.length ? view.checks.every((check) => check.result === "passed") ? "checks passed" : "check warning" : "No verified checks recorded"}` : ""}</p>
			</div>
			{#if canPrepare}
				<button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy} onclick={review}>{busy ? "Preparing review…" : "Prepare PR review"}</button>
			{:else if view.state === "ready" || view.state === "reviewing"}
				<div class="flex flex-wrap gap-2"><button class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)]" onclick={() => onreview(view!)}>View diff</button><button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500" onclick={() => onreview(view!)}>Review &amp; create draft PR</button></div>
			{:else if view.state === "creating" || view.state === "failed"}
				<button class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)]" onclick={() => onreview(view!)}>Open PR review</button>
			{:else if view.state === "created" && trustedGithubPrUrl(view.prUrl)}
				<a class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)]" href={trustedGithubPrUrl(view.prUrl) ?? undefined} target="_blank" rel="noopener noreferrer">View PR on GitHub</a>
			{:else if view.state === "blocked" && view.blockReason !== "run_not_successful"}
				<a class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)]" href={githubSettingsHref}>Manage GitHub access</a>
			{/if}
		</div>
		{#if view.state === "ready" || view.state === "reviewing"}<p class="mt-2 text-xs text-[var(--color-text-muted)]">Nothing pushed yet.</p>{/if}
			{#if view.state === "no_changes"}<p class="mt-2 text-sm text-[var(--color-text-secondary)]" role="status">Make a change in this sandbox, then complete another run.</p>{/if}
			{#if reason}<p class="mt-2 text-sm text-[var(--color-text-secondary)]" role="status">{reason}</p>{/if}
		{#if view.state === "stale"}<p class="mt-2 text-sm text-red-700 dark:text-red-300" role="status">This draft needs a new review before GitHub can be updated.</p>{/if}
		{#if error}<p class="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>{/if}
	</section>
{:else if error}
	<p class="mx-4 my-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>
{/if}
