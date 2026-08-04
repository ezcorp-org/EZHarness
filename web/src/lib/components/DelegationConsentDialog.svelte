<!--
	The C3 delegation consent dialog.

	Where a person decides that an extension may run one of their workflows,
	unattended, without them present. It is the only place that authority is
	ever minted, so everything the decision depends on is on screen at once:
	which principal the job will carry, what the workflow can reach, what the
	spend ceiling does NOT cover, and what a service account cannot do.

	Two rules the markup follows throughout:

	1. **Server-derived text is rendered, never re-composed.** The reach
	   warning and the consent refusal are sentences the server wrote; this
	   file positions them and does not paraphrase them.
	2. **Nothing is pre-approved.** Both bounds start empty and the primary
	   action stays disabled with a visible reason until they are set. The
	   install dialog's opposite convention (capability toggles default ON)
	   is right for reviewing a declaration; this is minting standing
	   authority, which is a different act.
-->
<script lang="ts">
	import {
		OWNER_KIND_CHOICES,
		closureWarnings,
		conditionalSteps,
		consentBlockedReason,
		diffCapabilities,
		previewConsent,
		reachWarningFor,
		submitConsent,
		summarizeCapabilities,
		tokenBoundExclusions,
		type CapabilityRow,
		type ConsentDraft,
		type ConsentPreview,
		type Delegation,
		type DelegationOwnerKind,
		type ServiceAccountOption,
		type ServiceAccountReach,
	} from "$lib/workflow-delegations-logic";

	interface Props {
		extensionId: string;
		extensionName: string;
		jobRef: string;
		workflowName: string;
		triggerKind: string;
		projectId?: string | null;
		/** Populated only for an admin — `GET /api/service-accounts` is
		 *  admin-gated, so an ordinary user legitimately sees an empty list
		 *  and is told why rather than shown a broken picker. */
		serviceAccounts?: ServiceAccountOption[];
		/** Present when this replaces an existing consent, so the diff can
		 *  show what CHANGED rather than restating everything. */
		previousCapabilities?: CapabilityRow[] | null;
		onclose: () => void;
		ondone: (delegation: Delegation) => void;
	}

	let {
		extensionId,
		extensionName,
		jobRef,
		workflowName,
		triggerKind,
		projectId = null,
		serviceAccounts = [],
		previousCapabilities = null,
		onclose,
		ondone,
	}: Props = $props();

	let ownerKind = $state<DelegationOwnerKind>("user");
	let ownerServiceAccountId = $state<string | null>(null);
	let maxTokensPerRun = $state<number | null>(null);
	let maxRunsPerDay = $state<number | null>(null);

	let preview = $state<ConsentPreview | null>(null);
	/** The server's own sentence when the preview refuses — §6.1's reason
	 *  and remedy, or a version-divergence 409. Never replaced by a status. */
	let previewError = $state<string | null>(null);
	let previewing = $state(false);
	let submitting = $state(false);
	let submitError = $state<string | null>(null);

	const draft = $derived<ConsentDraft>({
		extensionId,
		jobRef,
		workflowName,
		ownerKind,
		ownerServiceAccountId,
		projectId,
		triggerKind,
		maxTokensPerRun,
		maxRunsPerDay,
	});

	/**
	 * The reach object, held SEPARATELY from the preview and never cleared.
	 *
	 * It describes what a service account can reach ON THIS INSTANCE — a
	 * property of the ladder, not of any one preview. Deriving it from
	 * `preview` made the warning vanish in the one situation that needs it
	 * most: choosing "service account" with none selected clears the
	 * preview (there is no principal to preview yet), which took the
	 * warning down with it. The first preview — which runs as `user` on
	 * open, and succeeds — is what seeds this.
	 */
	let reach = $state<ServiceAccountReach | null>(null);
	const reachWarning = $derived(reachWarningFor(ownerKind, reach));

	const capabilities = $derived<CapabilityRow[]>(
		preview === null ? [] : summarizeCapabilities(preview.material),
	);
	const diff = $derived(diffCapabilities(previousCapabilities, capabilities));
	const conditionals = $derived(preview === null ? [] : conditionalSteps(preview.material));
	const warnings = $derived(preview === null ? [] : closureWarnings(preview.material));
	const exclusions = $derived(
		preview === null
			? []
			: tokenBoundExclusions({
					maxToolCallsPerRun: preview.maxToolCallsPerRun,
					maxNestingDepth: preview.maxNestingDepth,
					effortNoops: preview.effortNoops,
				}),
	);

	/**
	 * Why approve is disabled, in the order a person can ACT on.
	 *
	 * The owner-selection gap is checked ahead of the preview's absence:
	 * picking "service account" with none selected leaves nothing to
	 * preview, and reporting that as "Loading…" describes a wait that is
	 * never going to end instead of the choice that is missing.
	 */
	const blockedReason = $derived.by(() => {
		if (previewError !== null) return previewError;
		const draftReason = consentBlockedReason(draft);
		if (ownerKind === "service" && !ownerServiceAccountId) return draftReason;
		if (preview === null) return "Loading what this job would be allowed to do…";
		return draftReason;
	});

	/**
	 * Re-preview whenever the OWNER changes.
	 *
	 * The principal is a hash input and it is what §6.1 authorizes against,
	 * so switching between "run as me" and a service account can change the
	 * capability set, or make the whole thing refuse. Previewing once at
	 * open would show the answer to a question the person has since changed.
	 */
	$effect(() => {
		const kind = ownerKind;
		const accountId = ownerServiceAccountId;
		// A service delegation with no account chosen is not a question the
		// server can answer yet; the picker asks for one first.
		if (kind === "service" && !accountId) {
			preview = null;
			previewError = null;
			return;
		}
		let cancelled = false;
		previewing = true;
		previewConsent({
			extensionId,
			jobRef,
			workflowName,
			ownerKind: kind,
			ownerServiceAccountId: accountId,
			projectId,
			triggerKind,
			maxTokensPerRun: null,
			maxRunsPerDay: null,
		}).then((result) => {
			if (cancelled) return;
			previewing = false;
			if (result.ok) {
				preview = result.value;
				// Latched, not cleared: see the `reach` declaration.
				reach = result.value.reach;
				previewError = null;
			} else {
				preview = null;
				previewError = result.message;
			}
		});
		return () => {
			cancelled = true;
		};
	});

	async function approve() {
		if (consentBlockedReason(draft) !== null || previewError !== null) return;
		submitting = true;
		submitError = null;
		const result = await submitConsent(draft);
		submitting = false;
		if (!result.ok) {
			submitError = result.message;
			return;
		}
		ondone(result.value.delegation);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
	onkeydown={(e) => {
		if (e.key === "Escape") onclose();
	}}
	onclick={(e) => {
		if (e.target === e.currentTarget) onclose();
	}}
>
	<div
		class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-xl"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delegation-consent-title"
		data-testid="delegation-consent"
	>
		<div class="border-b border-[var(--color-border)] px-6 py-4">
			<h3
				id="delegation-consent-title"
				class="text-base font-semibold text-[var(--color-text-primary)]"
			>
				Let {extensionName} run “{workflowName}” for you
			</h3>
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">
				This grants standing authority: the extension can start this workflow on its own,
				without asking again. You can revoke it at any time.
			</p>
		</div>

		<div class="flex-1 space-y-5 overflow-y-auto px-6 py-5">
			<!-- ── Owner kind (Ruling 1) ────────────────────────────────── -->
			<fieldset data-testid="owner-kind-picker">
				<legend class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
					Run these jobs as
				</legend>
				<div class="mt-2 space-y-2">
					{#each OWNER_KIND_CHOICES as choice (choice.kind)}
						<label
							class="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors {ownerKind ===
							choice.kind
								? 'border-blue-500/60 bg-blue-500/10'
								: 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-muted)]'}"
						>
							<input
								type="radio"
								name="owner-kind"
								value={choice.kind}
								checked={ownerKind === choice.kind}
								onchange={() => {
									ownerKind = choice.kind;
									if (choice.kind === "user") ownerServiceAccountId = null;
								}}
								class="mt-0.5 accent-blue-500"
								data-testid="owner-kind-{choice.kind}"
							/>
							<span>
								<span class="block text-sm font-medium text-[var(--color-text-primary)]"
									>{choice.label}</span
								>
								<span class="mt-0.5 block text-xs text-[var(--color-text-muted)]"
									>{choice.detail}</span
								>
							</span>
						</label>
					{/each}
				</div>

				{#if ownerKind === "service"}
					<div class="mt-3">
						{#if serviceAccounts.length === 0}
							<p
								class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)]"
								data-testid="no-service-accounts"
							>
								No service account is available to you. Only an administrator can create one,
								and only an administrator can list them — ask one to set an account up, or
								choose “Run as me”.
							</p>
						{:else}
							<label
								class="block text-xs font-medium text-[var(--color-text-secondary)]"
								for="service-account-select">Service account</label
							>
							<select
								id="service-account-select"
								bind:value={ownerServiceAccountId}
								class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
								data-testid="service-account-select"
							>
								<option value={null}>Choose an account…</option>
								{#each serviceAccounts as account (account.id)}
									<option value={account.id} disabled={!account.enabled}>
										{account.name}{account.enabled ? "" : " (disabled)"}
									</option>
								{/each}
							</select>
						{/if}
					</div>
				{/if}

				<!-- ── The system-only reach warning ────────────────────────
				     Phase 2's `reach.message`, rendered verbatim. It names the
				     reason AND both remedies, so nothing is added here. -->
				{#if reachWarning}
					<p
						class="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-[var(--color-text-primary)]"
						data-testid="reach-warning"
					>
						{reachWarning}
					</p>
				{/if}
			</fieldset>

			<!-- ── The refusal, or the capability diff ──────────────────── -->
			{#if previewError}
				<!-- The server's sentence, not a status line: §6.1's refusal
				     already names the remedy ("choose run as me, or ask an
				     admin to make the workflow system-visible"). -->
				<p
					class="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-[var(--color-text-primary)]"
					data-testid="consent-refused"
				>
					{previewError}
				</p>
			{:else if previewing && preview === null}
				<p class="text-sm text-[var(--color-text-muted)]" data-testid="preview-loading">
					Working out what this job would be allowed to do…
				</p>
			{:else if preview}
				<section data-testid="capability-diff">
					<h4
						class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]"
					>
						{previousCapabilities ? "What changes" : "What this job will be able to do"}
					</h4>

					{#if previousCapabilities && diff.added.length === 0 && diff.removed.length === 0}
						<!-- Ruling 2 re-asks on ANY edit, including one that changes
						     no capability. Saying so plainly is what lets a person
						     approve quickly HERE without learning to approve
						     everything quickly. -->
						<p class="mt-2 text-sm text-[var(--color-text-secondary)]" data-testid="diff-unchanged">
							Nothing about what this job can do has changed. The workflow was edited, so your
							approval is being asked for again.
						</p>
					{/if}

					{#each [{ rows: diff.added, label: previousCapabilities ? "Newly allowed" : "Allowed", tone: "add" }, { rows: diff.removed, label: "No longer allowed", tone: "remove" }] as group (group.label)}
						{#if group.rows.length > 0}
							<p class="mt-3 text-xs font-medium text-[var(--color-text-secondary)]">
								{group.label}
							</p>
							<ul class="mt-1.5 space-y-1">
								{#each group.rows as row (row.kind + "::" + row.value)}
									<li
										class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-2 py-1 text-xs {group.tone ===
										'remove'
											? 'bg-[var(--color-surface)] text-[var(--color-text-muted)] line-through'
											: row.sensitive
												? 'bg-red-500/10 text-[var(--color-text-primary)] font-medium'
												: 'bg-[var(--color-surface)] text-[var(--color-text-secondary)]'}"
										data-testid="capability-row"
									>
										<code class="font-semibold">{row.kind}</code>
										{#if row.value}<code>{row.value}</code>{/if}
										<span class="text-[10px] text-[var(--color-text-muted)]">
											via {row.fromWorkflows.join(", ")}
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					{/each}

					{#if capabilities.length === 0}
						<p class="mt-2 text-sm text-[var(--color-text-secondary)]" data-testid="no-capabilities">
							This workflow reaches no tools, agents or models of its own.
						</p>
					{/if}
				</section>

				<!-- ── `when`-guarded steps ─────────────────────────────────
				     Showable, and shown: a `when` guard is a hash input in its
				     own right, so it is already in the material. A conditional
				     `shell` step contributes its capability unconditionally —
				     the set says the job MAY run shell and only the guard says
				     when, so the guard is what makes the list above honest. -->
				{#if conditionals.length > 0}
					<section data-testid="conditional-steps">
						<h4
							class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]"
						>
							Steps that only run under a condition
						</h4>
						<ul class="mt-2 space-y-1">
							{#each conditionals as step (step.workflowName + "." + step.stepName)}
								<li
									class="rounded bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
									data-testid="conditional-step"
								>
									<code class="font-medium text-[var(--color-text-primary)]"
										>{step.workflowName}.{step.stepName}</code
									>
									<span class="text-[var(--color-text-muted)]"> ({step.kind}) runs when </span>
									<code>{step.when}</code>
									{#if !step.skipDependents}
										<span class="ml-1 font-medium text-[var(--color-brand)]"
											>— steps that depend on it still run when it is skipped</span
										>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if warnings.length > 0}
					<section data-testid="closure-warnings">
						<ul class="space-y-1.5">
							{#each warnings as warning (warning.id)}
								<li
									class="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-[var(--color-text-primary)]"
									data-testid="closure-warning-{warning.id}"
								>
									{warning.text}
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/if}

			<!-- ── The two bounds ───────────────────────────────────────── -->
			<section>
				<h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
					Limits
				</h4>
				<div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div>
						<label
							class="block text-xs font-medium text-[var(--color-text-secondary)]"
							for="max-tokens-per-run">Language-model tokens per run</label
						>
						<input
							id="max-tokens-per-run"
							type="number"
							min="1"
							step="1"
							inputmode="numeric"
							placeholder="e.g. 200000"
							value={maxTokensPerRun ?? ""}
							oninput={(e) => {
								const raw = e.currentTarget.value;
								maxTokensPerRun = raw === "" ? null : Number(raw);
							}}
							class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
							data-testid="max-tokens-per-run"
						/>
					</div>
					<div>
						<label
							class="block text-xs font-medium text-[var(--color-text-secondary)]"
							for="max-runs-per-day">Runs per day</label
						>
						<input
							id="max-runs-per-day"
							type="number"
							min="1"
							step="1"
							inputmode="numeric"
							placeholder="e.g. 24"
							value={maxRunsPerDay ?? ""}
							oninput={(e) => {
								const raw = e.currentTarget.value;
								maxRunsPerDay = raw === "" ? null : Number(raw);
							}}
							class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
							data-testid="max-runs-per-day"
						/>
					</div>
				</div>

				<!-- ── WHAT THE TOKEN LIMIT DOES NOT COVER ──────────────────
				     The honesty requirement. A person reads a token cap as a
				     bound on the whole job; it is a bound on language-model
				     spend only, and the two ways out of it are not obvious
				     from anywhere else in this dialog. -->
				{#if exclusions.length > 0}
					<div
						class="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
						data-testid="token-bound-exclusions"
					>
						<p class="text-xs font-semibold text-[var(--color-text-primary)]">
							What the token limit does not cover
						</p>
						<ul class="mt-1.5 space-y-1.5">
							{#each exclusions as exclusion (exclusion.id)}
								<li
									class="text-xs text-[var(--color-text-secondary)]"
									data-testid="exclusion-{exclusion.id}"
								>
									{exclusion.text}
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<!-- Ruling 3: tokens are enforced, cost is advisory. No cents
				     cap is shown or collected anywhere in this dialog, because
				     an unpriced (OAuth-subscription) model reports a null price
				     and would spend without bound under one. -->
			</section>

			{#if submitError}
				<p
					class="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-[var(--color-text-primary)]"
					data-testid="consent-submit-error"
				>
					{submitError}
				</p>
			{/if}
		</div>

		<div
			class="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-6 py-4"
		>
			<!-- The reason lives NEXT TO the disabled button, not inside a
			     tooltip: a disabled primary action with no visible explanation
			     is how a consent dialog becomes a dead end. -->
			<p class="text-xs text-[var(--color-text-muted)]" data-testid="consent-blocked-reason">
				{blockedReason ?? ""}
			</p>
			<div class="flex shrink-0 gap-2">
				<button
					type="button"
					onclick={onclose}
					disabled={submitting}
					class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50"
					data-testid="consent-cancel">Cancel</button
				>
				<button
					type="button"
					onclick={approve}
					disabled={submitting || blockedReason !== null}
					class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
					data-testid="consent-approve"
				>
					{submitting ? "Approving…" : "Approve"}
				</button>
			</div>
		</div>
	</div>
</div>
