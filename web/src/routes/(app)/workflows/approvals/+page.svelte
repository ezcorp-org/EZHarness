<script lang="ts">
	import { onMount } from "svelte";
	import {
		buildAnswerBody,
		canSubmit,
		describeAge,
		describeDeadline,
		describeOutcome,
		toggleItem,
		type PendingApproval,
	} from "$lib/workflow-approvals-logic";

	let approvals = $state<PendingApproval[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	/** approvalId → the items the human has ticked. */
	let selected = $state<Record<string, string[]>>({});
	/** approvalId → in-flight, so a double-click cannot answer twice. */
	let submitting = $state<Record<string, boolean>>({});
	/** approvalId → what happened, kept after the row leaves the list. */
	let outcome = $state<Record<string, { tone: string; text: string }>>({});

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch("/api/workflows/approvals");
			if (!res.ok) {
				loadError = `Could not load approvals (${res.status})`;
				return;
			}
			approvals = ((await res.json()) as { approvals: PendingApproval[] }).approvals;
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function answer(approval: PendingApproval, choice: string) {
		submitting = { ...submitting, [approval.id]: true };
		try {
			const res = await fetch(`/api/workflows/approvals/${approval.id}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(buildAnswerBody(approval, choice, selected[approval.id] ?? [])),
			});
			const body = (await res.json().catch(() => ({}))) as {
				run?: { status?: string };
				error?: string;
			};
			if (!res.ok) {
				// The answer may still have been RECORDED — `resume-failed`
				// means exactly that — so this never says "not answered".
				outcome = {
					...outcome,
					[approval.id]: { tone: "error", text: body.error ?? `Failed (${res.status})` },
				};
				return;
			}
			outcome = { ...outcome, [approval.id]: describeOutcome(body.run?.status) };
			// Drop the answered row locally rather than refetching: the list is
			// the set of OPEN questions, and this one is closed.
			approvals = approvals.filter((a) => a.id !== approval.id);
		} finally {
			submitting = { ...submitting, [approval.id]: false };
		}
	}
</script>

<div class="space-y-6" data-testid="approvals-inbox">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">Approvals</h2>
		<button
			type="button"
			onclick={load}
			class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-text-muted)]"
			data-testid="approvals-refresh">Refresh</button
		>
	</div>

	<p class="text-xs text-[var(--color-text-muted)]">
		Workflow runs parked on a decision. Answering one continues its run; a run stays parked, and
		answerable, until someone decides.
	</p>

	{#each Object.entries(outcome) as [id, o] (id)}
		<p
			class="rounded-md border p-2 text-xs {o.tone === 'error'
				? 'border-red-500/40 bg-red-500/10 text-red-300'
				: o.tone === 'warn'
					? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
					: 'border-green-500/40 bg-green-500/10 text-green-300'}"
			data-testid="approval-outcome"
		>
			{o.text}
		</p>
	{/each}

	{#if loading}
		<p class="text-[var(--color-text-muted)]" data-testid="approvals-loading">Loading…</p>
	{:else if loadError}
		<p class="text-red-400" data-testid="approvals-error">{loadError}</p>
	{:else if approvals.length === 0}
		<p class="text-[var(--color-text-muted)]" data-testid="approvals-empty">
			Nothing is waiting on you.
		</p>
	{:else}
		<div class="space-y-3">
			{#each approvals as approval (approval.id)}
				<div
					class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
					data-testid="approval-card"
				>
					<div class="flex flex-wrap items-center gap-2 text-xs">
						<a
							href="/workflows/{approval.workflowName}"
							class="font-medium text-[var(--color-text-primary)] hover:underline"
							data-testid="approval-workflow">{approval.workflowName}</a
						>
						<span
							class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 uppercase tracking-wide text-[var(--color-text-muted)]"
							data-testid="approval-step">{approval.stepName}</span
						>
						<span class="text-[var(--color-text-muted)]" data-testid="approval-age"
							>parked {describeAge(approval.createdAt, new Date())}</span
						>
						{#if describeDeadline(approval.expiresAt, new Date())}
							{@const deadline = describeDeadline(approval.expiresAt, new Date())}
							<!-- Rendered because the timeout sweep answers on the clock's
							     behalf: a decision that expires unseen is indistinguishable,
							     afterwards, from one nobody looked at. -->
							<span
								class="rounded px-1.5 py-0.5 font-medium {deadline?.urgent
									? 'bg-red-900/50 text-red-200'
									: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}"
								data-testid="approval-deadline">{deadline?.text}</span
							>
						{/if}
					</div>
					<p class="mt-2 text-sm text-[var(--color-text-primary)]" data-testid="approval-prompt">
						{approval.prompt}
					</p>

					{#if approval.requireItemConsent}
						<div
							class="mt-3 rounded-md border border-[var(--color-warning,#f59e0b)]/50 bg-[var(--color-warning,#f59e0b)]/10 p-3"
						>
							<p class="text-xs font-semibold text-[var(--color-text-primary)]"
								data-testid="approval-consent-note">
								Tick each item you are consenting to. Nothing is approved by default.
							</p>
							<ul class="mt-2 space-y-1">
								{#each approval.itemIds as itemId (itemId)}
									<li class="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
										<input
											type="checkbox"
											checked={(selected[approval.id] ?? []).includes(itemId)}
											onchange={() =>
												(selected = {
													...selected,
													[approval.id]: toggleItem(selected[approval.id] ?? [], itemId),
												})}
											data-testid="approval-item"
											aria-label={itemId}
										/>
										<span>{itemId}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					<div class="mt-3 flex flex-wrap gap-2">
						{#each approval.choices as choice (choice)}
							<button
								type="button"
								disabled={!canSubmit(
									approval,
									selected[approval.id] ?? [],
									submitting[approval.id] === true,
								)}
								onclick={() => answer(approval, choice)}
								class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
								data-testid="approval-choice">{choice}</button
							>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
