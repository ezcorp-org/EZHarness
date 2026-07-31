<script lang="ts">
	import {
		buildAnswerBody,
		canSubmit,
		describeDeadline,
		submitApprovalAnswer,
		toggleItem,
		trayConsentPlan,
		type PendingApprovalNotice,
	} from "$lib/workflow-approvals-logic";

	/**
	 * One parked workflow approval, answerable in place.
	 *
	 * The THIRD answer surface (the inbox and the Hub action are the other
	 * two), and like both of them it answers through
	 * `POST /api/workflows/approvals/:id` — i.e. through `answerApproval`,
	 * the one chokepoint. This component deliberately owns no rule of its
	 * own: which items may be sent is `buildAnswerBody`'s call, whether the
	 * button is live is `canSubmit`'s, and whether this surface may take
	 * the decision at all is `trayConsentPlan`'s.
	 *
	 * Why a tray card and not a message in the chat: the decision arrives
	 * asynchronously, typically minutes after whatever started the run, and
	 * a durable run outlives the tab it was started from. There is no
	 * conversation to render into by the time it parks.
	 *
	 * It does NOT render `formatGateRelay`'s text. That is the LLM-facing
	 * rendering and opens "RELAY THIS TO THE USER VERBATIM" — an
	 * instruction addressed to a model. A human reading it here would be
	 * reading someone else's mail.
	 */
	let { approval, onResolved }: {
		approval: PendingApprovalNotice;
		onResolved: () => void;
	} = $props();

	let selected = $state<string[]>([]);
	let inFlight = $state(false);
	let error = $state<string | null>(null);

	let plan = $derived(trayConsentPlan(approval));
	let deadline = $derived(describeDeadline(approval.expiresAt, new Date()));
	/** `inbox` mode means this surface has refused the decision, so nothing
	 *  it could send would be an informed answer. */
	let answerable = $derived(plan.mode !== "inbox");

	async function answer(choice: string) {
		inFlight = true;
		error = null;
		try {
			const result = await submitApprovalAnswer(
				approval.approvalId,
				buildAnswerBody(approval, choice, selected),
			);
			if (!result.ok) {
				// Never "not answered" — see `submitApprovalAnswer`. The card
				// stays so the outcome is readable; dismissing it here would
				// take the only report of what happened with it.
				error = result.message;
				return;
			}
			onResolved();
		} finally {
			inFlight = false;
		}
	}
</script>

<div
	class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3 shadow-xl"
	data-testid="pending-approval-card"
	data-approval-id={approval.approvalId}
>
	<div class="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-text-secondary)]">
		<span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400"></span>
		<span data-testid="pending-approval-source">
			{approval.workflowName} · {approval.stepName}
		</span>
		{#if deadline}
			<span
				class="ml-auto rounded px-1.5 py-0.5 {deadline.urgent
					? 'bg-red-900/50 text-red-200'
					: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}"
				data-testid="pending-approval-deadline">{deadline.text}</span
			>
		{/if}
	</div>

	<p class="text-sm text-[var(--color-text-primary)]" data-testid="pending-approval-prompt">
		{approval.prompt}
	</p>

	{#if plan.mode === "tick"}
		<div class="mt-3 rounded-md border border-[var(--color-warning,#f59e0b)]/50 bg-[var(--color-warning,#f59e0b)]/10 p-2">
			<p class="mb-2 text-xs text-[var(--color-text-secondary)]" data-testid="pending-approval-consent-note">
				Tick the items you are deciding on — only these are sent.
			</p>
			{#each plan.items as item (item)}
				<label class="flex items-center gap-2 py-0.5 text-xs text-[var(--color-text-primary)]">
					<input
						type="checkbox"
						checked={selected.includes(item)}
						onchange={() => (selected = toggleItem(selected, item))}
						data-testid="pending-approval-item"
					/>
					<span class="truncate">{item}</span>
				</label>
			{/each}
		</div>
	{:else if plan.mode === "inbox"}
		<!-- Too many items to read in a corner overlay. Truncating the list
		     and taking the answer anyway would let someone consent to a set
		     they were never shown — so this surface declines. -->
		<div class="mt-3 rounded-md border border-[var(--color-border)] p-2 text-xs">
			<p class="text-[var(--color-text-secondary)]" data-testid="pending-approval-too-many">
				{plan.items.length} items need your consent — too many to review here.
			</p>
			<a
				class="mt-1 inline-block font-medium text-[var(--color-accent,#38bdf8)] hover:underline"
				href="/workflows/approvals"
				data-testid="pending-approval-inbox-link">Review them in the approvals inbox →</a
			>
		</div>
	{/if}

	{#if answerable}
		<div class="mt-3 flex flex-wrap gap-2">
			{#each approval.choices as choice (choice)}
				<button
					type="button"
					class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-muted)] disabled:cursor-not-allowed disabled:opacity-40"
					disabled={!canSubmit(approval, selected, inFlight)}
					onclick={() => answer(choice)}
					data-testid="pending-approval-choice">{choice}</button
				>
			{/each}
		</div>
	{/if}

	{#if error}
		<p class="mt-2 text-xs text-red-300" data-testid="pending-approval-error">{error}</p>
	{/if}
</div>
