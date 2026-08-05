<!--
	Delegations — standing authority a person has granted, and what it has done.

	Sits beside `/workflows/approvals` deliberately. Approvals is where you
	spend authority once; this is where you grant it standing, review what it
	did, and take it back. Same shell, same rhythm, so the two read as the
	two halves of one idea.

	The "jobs running as me" list reads its own server route rather than the
	extension-facing runs surface: `readRuns` scopes to the names a grant
	covers AND to the acting user, and a delegated-only grant lists no names
	while a scheduled fire has no acting user — so a delegated run is
	invisible there by construction. That is right for an extension and
	exactly why the human's view needs its own read.
-->
<script lang="ts">
	import { onMount, tick, untrack } from "svelte";
	import { page } from "$app/state";
	import { store, refreshWorkflows } from "$lib/stores.svelte.js";
	import DelegationConsentDialog from "$lib/components/DelegationConsentDialog.svelte";
	import {
		TRIGGER_KIND_CHOICES,
		describeDelegationState,
		describeGrantPrefill,
		describeRunPrincipal,
		describeRunStopReason,
		describeRunTime,
		describeRunStatus,
		grantParams,
		loadDelegatedRuns,
		loadDelegations,
		loadServiceAccounts,
		patchDelegationBounds,
		resolveGrantPrefill,
		revokeDelegation,
		type Delegation,
		type DelegatedRun,
		type GrantPrefill,
		type ParamReader,
		type ServiceAccountOption,
	} from "$lib/workflow-delegations-logic";

	let delegations = $state<Delegation[]>([]);
	let runs = $state<DelegatedRun[]>([]);
	let serviceAccounts = $state<ServiceAccountOption[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	/** delegationId → the edited token ceiling, while it is being edited. */
	let editingTokens = $state<Record<string, number | null>>({});
	/** delegationId → the edited daily run quota, while it is being edited. */
	let editingRuns = $state<Record<string, number | null>>({});
	/** delegationId → in flight, so a double-click cannot act twice. */
	let busy = $state<Record<string, boolean>>({});
	/** delegationId → what happened, kept after the row changes. */
	let rowMessage = $state<Record<string, { tone: "ok" | "error"; text: string }>>({});

	const accountsById = $derived(
		Object.fromEntries(serviceAccounts.map((a) => [a.id, a.name])) as Record<string, string>,
	);

	/**
	 * Extensions that may hold a delegation at all.
	 *
	 * The gate is the GRANTED permission, not the manifest declaration: an
	 * install can decline `allowDelegated`, and an extension the admin
	 * declined must not be offerable here. Reading the grant is also what
	 * makes this list agree with what the host will actually authorize at
	 * fire time.
	 */
	interface DelegatableExtension {
		id: string;
		name: string;
	}
	let extensions = $state<DelegatableExtension[]>([]);

	/** The "what to delegate" step, before the consent dialog opens. */
	let granting = $state(false);
	let draftExtensionId = $state("");
	let draftWorkflowName = $state("");
	let draftJobRef = $state("");
	let draftTriggerKind = $state("cron");
	let reviewing = $state(false);

	const draftExtension = $derived(extensions.find((e) => e.id === draftExtensionId) ?? null);
	const canReview = $derived(
		draftExtension !== null && draftWorkflowName !== "" && draftJobRef.trim() !== "",
	);

	// ── The job → consent handoff ─────────────────────────────────────
	//
	// Two things fill this form in for you: a deep link from the console
	// that owns the job (`?extensionId=&jobRef=&workflowName=&triggerKind=`),
	// and the "Grant this again" button on a delegation that has gone
	// stale. BOTH go through `resolveGrantPrefill`, which matches every
	// field against the lists this page already loaded and refuses — out
	// loud — anything they do not contain.
	//
	// What a prefill deliberately does NOT do is submit. It opens the
	// form with values on screen; the person still opens the review
	// dialog, still types both spend bounds, and still presses Approve.
	// C3 exists because an absent grant was once read as approval, so a
	// URL that could mint one would be the same mistake wearing a
	// different hat.

	/** What the last prefill filled in and what it refused, for the note. */
	let prefill = $state<GrantPrefill | null>(null);
	/** The `?…` string already consumed, so a re-render cannot re-apply it
	 *  over edits the person has since made to the form. */
	let consumedSearch: string | null = null;
	let grantFormEl = $state<HTMLDivElement | null>(null);

	async function applyPrefill(params: ParamReader) {
		const resolved = resolveGrantPrefill(params, {
			extensions,
			// The workflow picker's own options — so a link can only name a
			// workflow this session can already see and select by hand.
			workflowNames: store.workflows.map((w) => w.name),
			current: {
				extensionId: draftExtensionId,
				workflowName: draftWorkflowName,
				jobRef: draftJobRef,
				triggerKind: draftTriggerKind,
			},
		});
		if (resolved === null) return;
		draftExtensionId = resolved.draft.extensionId;
		draftWorkflowName = resolved.draft.workflowName;
		draftJobRef = resolved.draft.jobRef;
		draftTriggerKind = resolved.draft.triggerKind;
		prefill = resolved;
		granting = true;
		// The form is above the list, so a "Grant this again" from a card
		// further down would otherwise fill in a form nobody can see.
		await tick();
		grantFormEl?.scrollIntoView({ block: "nearest" });
	}

	/**
	 * Re-grant an existing delegation.
	 *
	 * The remedy the page already names in two places — "Grant it again to
	 * restore it" on a stopped row, and "Approve it again to release it"
	 * on a `consent-stale` run — and until now it named it without
	 * offering it. A bundled extension's workflows ship inside the app
	 * image, so any release that edits one of its `*.workflow.yaml` files
	 * invalidates the consent hash and parks the next fire; this is the
	 * button that ends that outage.
	 *
	 * Routed through the same resolver as a link, using the delegation's
	 * OWN four fields, so a re-grant whose workflow has since disappeared
	 * says so instead of seeding a form that cannot be submitted.
	 */
	function grantAgain(delegation: Delegation) {
		void applyPrefill(grantParams(delegation));
	}

	async function loadDelegatableExtensions() {
		try {
			const res = await fetch("/api/extensions");
			if (!res.ok) return;
			const data = (await res.json()) as {
				extensions?: Array<{
					id: string;
					name: string;
					enabled?: boolean;
					grantedPermissions?: { workflows?: { allowDelegated?: boolean } };
				}>;
			};
			extensions = (data.extensions ?? [])
				.filter((e) => e.enabled !== false && e.grantedPermissions?.workflows?.allowDelegated)
				.map((e) => ({ id: e.id, name: e.name }));
		} catch {
			// A failed read leaves the grant form empty and the rest of the
			// page working. It must never take the revoke button down with it.
			extensions = [];
		}
	}

	async function load() {
		loading = true;
		loadError = null;

		// Awaited, not fired and forgotten: `store.workflows` is what a
		// prefill's workflow name is CHECKED against, so applying a deep
		// link before the list arrives would refuse every workflow on the
		// instance and tell the user their link was bad. The refresh always
		// resolves and leaves the previous list in place on failure.
		const [listed, ran] = await Promise.all([
			loadDelegations(),
			loadDelegatedRuns(),
			refreshWorkflows(),
		]);
		if (!listed.ok) {
			loadError = listed.message;
			loading = false;
			return;
		}
		delegations = listed.value.delegations;
		// A failed runs read is reported in place rather than failing the
		// page: the delegation list is the part that lets someone REVOKE,
		// and it must never be unreachable because a history read broke.
		runs = ran.ok ? ran.value.runs : [];

		// Reachable by any session now: an admin gets the full rows, everyone
		// else gets `{id, name}` per live account. Used for two things — the
		// label on a service-account run, and the owner picker inside the
		// consent dialog, which had nothing to offer a non-admin before.
		const accounts = await loadServiceAccounts();
		serviceAccounts = accounts.ok ? accounts.value.accounts : [];
		await loadDelegatableExtensions();
		loading = false;
	}

	onMount(load);

	// Apply the URL's prefill once both pickers have something to check it
	// against — `loading` is the page's own readiness flag and `load()` now
	// awaits the workflow list too, so "not loading" means "both lists are
	// as good as they are going to get".
	//
	// A FAILED load is not readiness, and this gate is not cosmetic: an
	// error returns early without ever reading `/api/extensions`, so
	// applying a prefill against the empty lists that leaves behind would
	// tell someone their link names an extension that is not installed —
	// a confident, false sentence about a completely different problem.
	// A page that could not load cannot check a link, and says nothing.
	//
	// Only `page.url.search`, `loading` and `loadError` are tracked.
	// Everything the body touches — including the four draft fields it
	// WRITES — is untracked, or this effect would re-trigger itself.
	$effect(() => {
		const search = page.url.search;
		const ready = !loading && loadError === null;
		untrack(() => {
			if (!ready || search === consumedSearch) return;
			consumedSearch = search;
			void applyPrefill(page.url.searchParams);
		});
	});

	async function revoke(delegation: Delegation) {
		busy = { ...busy, [delegation.id]: true };
		const result = await revokeDelegation(delegation.id);
		busy = { ...busy, [delegation.id]: false };
		if (!result.ok) {
			rowMessage = { ...rowMessage, [delegation.id]: { tone: "error", text: result.message } };
			return;
		}
		rowMessage = {
			...rowMessage,
			[delegation.id]: result.value.revoked
				// "I revoked it" and "it was already gone" are the same security
				// outcome but not the same fact, and the UI must not claim to
				// have just ended an authority that ended last week.
				? { tone: "ok", text: "Revoked. This job can no longer start runs." }
				: { tone: "ok", text: "This was already revoked." },
		};
		delegations = delegations.filter((d) => d.id !== delegation.id);
	}

	/** A positive whole number, or `null` for "the user did not change this". */
	function editedBound(edited: number | null | undefined, current: number): number | null {
		if (edited === null || edited === undefined) return null;
		return edited === current ? null : edited;
	}

	/**
	 * Save whichever of the two spend bounds the user actually moved.
	 *
	 * Only the CHANGED fields are sent. The route's schema is `.strict()` and
	 * needs at least one, so echoing an untouched bound back would be a
	 * pointless write with a real cost: `updated_at` moves and the audit trail
	 * says somebody adjusted a number they did not touch. If nothing moved, no
	 * request is made at all — a no-op that reported "updated" would be a lie
	 * about a standing authority.
	 */
	async function saveLimits(delegation: Delegation) {
		const tokens = editedBound(editingTokens[delegation.id], delegation.maxTokensPerRun);
		const runs = editedBound(editingRuns[delegation.id], delegation.maxRunsPerDay);
		const invalid = [tokens, runs].some(
			(n) => n !== null && (!Number.isInteger(n) || n <= 0),
		);
		if (invalid) {
			rowMessage = {
				...rowMessage,
				[delegation.id]: { tone: "error", text: "Enter a whole number above zero." },
			};
			return;
		}
		if (tokens === null && runs === null) {
			rowMessage = {
				...rowMessage,
				[delegation.id]: { tone: "error", text: "Change a limit first." },
			};
			return;
		}
		busy = { ...busy, [delegation.id]: true };
		const result = await patchDelegationBounds(delegation.id, {
			...(tokens === null ? {} : { maxTokensPerRun: tokens }),
			...(runs === null ? {} : { maxRunsPerDay: runs }),
		});
		busy = { ...busy, [delegation.id]: false };
		if (!result.ok) {
			rowMessage = { ...rowMessage, [delegation.id]: { tone: "error", text: result.message } };
			return;
		}
		delegations = delegations.map((d) =>
			d.id === delegation.id ? result.value.delegation : d,
		);
		editingTokens = { ...editingTokens, [delegation.id]: null };
		editingRuns = { ...editingRuns, [delegation.id]: null };
		rowMessage = {
			...rowMessage,
			[delegation.id]: { tone: "ok", text: "Limits updated." },
		};
	}
</script>

<div class="space-y-6" data-testid="delegations-page">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">Delegations</h2>
		<div class="flex gap-2">
			<button
				type="button"
				onclick={() => (granting = !granting)}
				class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
				data-testid="delegations-grant">Grant a delegation</button
			>
			<button
				type="button"
				onclick={load}
			class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
				data-testid="delegations-refresh">Refresh</button
			>
		</div>
	</div>

	{#if granting}
		<!-- The "what to delegate" step. Kept OUT of the consent dialog: the
		     dialog's job is to show what a specific choice would authorize,
		     and a dialog that also changed the subject would be re-previewing
		     while someone reads it. -->
		<div
			class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
			data-testid="grant-form"
			bind:this={grantFormEl}
		>
			<!-- ── What a link chose for you ─────────────────────────────
			     Outside the extension-list branch on purpose: a link that
			     named an extension this instance cannot delegate to has to
			     be able to say so even when the picker itself is empty.

			     Naming the fields is the point. The values are visible in
			     the form below, but "these four came from the URL, not from
			     you" is the fact a person needs in order to look at them,
			     and it is the one a prefilled form otherwise hides. -->
			{#if prefill}
				{@const note = describeGrantPrefill(prefill)}
				{#if note}
					<p
						class="mb-3 rounded-md border border-blue-500/40 bg-blue-500/10 p-2.5 text-xs text-[var(--color-text-primary)]"
						data-testid="grant-prefill-note"
					>
						{note}
					</p>
				{/if}
				{#if prefill.rejected.length > 0}
					<!-- REFUSED, not silently ignored. A link naming a workflow
					     you cannot see must not quietly leave the previous
					     workflow selected — that is how someone approves one
					     thing while reading about another. -->
					<ul class="mb-3 space-y-1.5" data-testid="grant-prefill-rejected">
						{#each prefill.rejected as reason (reason)}
							<li
								class="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-[var(--color-text-primary)]"
								data-testid="grant-prefill-rejected-item"
							>
								{reason}
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
			{#if extensions.length === 0}
				<p class="text-sm text-[var(--color-text-secondary)]" data-testid="no-delegatable-extensions">
					No installed extension is allowed to run workflows on your behalf. An extension has to
					ask for that in its manifest, and an administrator has to approve it when enabling the
					extension.
				</p>
			{:else}
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div>
						<label class="block text-xs font-medium text-[var(--color-text-secondary)]" for="grant-ext"
							>Extension</label
						>
						<select
							id="grant-ext"
							bind:value={draftExtensionId}
							class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
							data-testid="grant-extension"
						>
							<option value="">Choose an extension…</option>
							{#each extensions as extension (extension.id)}
								<option value={extension.id}>{extension.name}</option>
							{/each}
						</select>
					</div>
					<div>
						<label class="block text-xs font-medium text-[var(--color-text-secondary)]" for="grant-wf"
							>Workflow</label
						>
						<select
							id="grant-wf"
							bind:value={draftWorkflowName}
							class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
							data-testid="grant-workflow"
						>
							<option value="">Choose a workflow…</option>
							{#each store.workflows as workflow (workflow.name)}
								<option value={workflow.name}>{workflow.name}</option>
							{/each}
						</select>
					</div>
					<div>
						<label class="block text-xs font-medium text-[var(--color-text-secondary)]" for="grant-job"
							>Job reference</label
						>
						<input
							id="grant-job"
							bind:value={draftJobRef}
							placeholder="the extension's own name for this job"
							class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
							data-testid="grant-job-ref"
						/>
					</div>
					<div>
						<label
							class="block text-xs font-medium text-[var(--color-text-secondary)]"
							for="grant-trigger">Trigger</label
						>
						<select
							id="grant-trigger"
							bind:value={draftTriggerKind}
							class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
							data-testid="grant-trigger"
						>
							<!-- The one list, shared with the consent dialog's subject
							     block. Two copies is how the dialog ends up naming a
							     trigger the form cannot select. -->
							{#each TRIGGER_KIND_CHOICES as choice (choice.kind)}
								<option value={choice.kind}>{choice.label}</option>
							{/each}
						</select>
					</div>
				</div>
				<div class="mt-3 flex justify-end">
					<button
						type="button"
						disabled={!canReview}
						onclick={() => (reviewing = true)}
						class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
						data-testid="grant-review">Review what this allows…</button
					>
				</div>
			{/if}
		</div>
	{/if}

	<p class="text-xs text-[var(--color-text-muted)]">
		Standing authority you have granted: an extension may start these workflows on its own,
		without asking again. Revoking one stops it immediately; the record of what it already ran
		stays below.
	</p>

	{#if loading}
		<p class="text-[var(--color-text-muted)]" data-testid="delegations-loading">Loading…</p>
	{:else if loadError}
		<p class="text-red-400" data-testid="delegations-error">{loadError}</p>
	{:else}
		<section>
			<h3 class="text-sm font-semibold text-[var(--color-text-primary)]">What you have granted</h3>
			{#if delegations.length === 0}
				<p class="mt-2 text-[var(--color-text-muted)]" data-testid="delegations-empty">
					You have not let any extension run a workflow on your behalf.
				</p>
			{:else}
				<div class="mt-3 space-y-3">
					{#each delegations as delegation (delegation.id)}
						{@const state = describeDelegationState(delegation)}
						<div
							class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
							data-testid="delegation-card"
						>
							<div class="flex flex-wrap items-center gap-2 text-xs">
								<a
									href="/workflows/{delegation.workflowName}"
									class="font-medium text-[var(--color-text-primary)] hover:underline"
									data-testid="delegation-workflow">{delegation.workflowName}</a
								>
								<span
									class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[var(--color-text-muted)]"
									data-testid="delegation-owner-kind"
								>
									{delegation.ownerKind === "user"
										? "runs as you"
										: `runs as ${accountsById[delegation.ownerId ?? ""] ?? "a service account"}`}
								</span>
								<span
									class="rounded px-1.5 py-0.5 font-medium {state.live
										? 'bg-green-500/15 text-[var(--color-text-primary)]'
										: 'bg-red-500/15 text-[var(--color-text-primary)]'}"
									data-testid="delegation-state">{state.text}</span
								>
								<span class="text-[var(--color-text-muted)]" data-testid="delegation-trigger"
									>{delegation.triggerKind}</span
								>
							</div>

							{#if !state.live}
								<!-- PATCH adjusts the budget; it does NOT re-enable a
								     disabled delegation and does not refresh consent. So a
								     stopped job needs re-consent, and offering one button
								     for both would be offering a remedy that cannot work. -->
								<p
									class="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text-secondary)]"
									data-testid="delegation-stopped-remedy"
								>
									Changing the limit will not restart this job. Use “Grant this again” below to
									restore it — you will be shown what it can do before anything is granted.
								</p>
							{/if}

							<div class="mt-3 flex flex-wrap items-end gap-3">
								<div>
									<label
										class="block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
										for="tokens-{delegation.id}">Tokens per run</label
									>
									<input
										id="tokens-{delegation.id}"
										type="number"
										min="1"
										step="1"
										inputmode="numeric"
										value={editingTokens[delegation.id] ?? delegation.maxTokensPerRun}
										oninput={(e) => {
											const raw = e.currentTarget.value;
											editingTokens = {
												...editingTokens,
												[delegation.id]: raw === "" ? null : Number(raw),
											};
										}}
										class="mt-1 w-36 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
										data-testid="delegation-tokens-input"
									/>
								</div>
								<div>
									<label
										class="block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
										for="runs-{delegation.id}">Runs per day</label
									>
									<input
										id="runs-{delegation.id}"
										type="number"
										min="1"
										step="1"
										inputmode="numeric"
										value={editingRuns[delegation.id] ?? delegation.maxRunsPerDay}
										oninput={(e) => {
											const raw = e.currentTarget.value;
											editingRuns = {
												...editingRuns,
												[delegation.id]: raw === "" ? null : Number(raw),
											};
										}}
										class="mt-1 w-36 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
										data-testid="delegation-runs-input"
									/>
								</div>
								<!-- ONE button for both bounds. Two would suggest two acts, and
								     they are one: the route takes either or both in a single
								     PATCH, and neither re-asks for consent. -->
								<button
									type="button"
									onclick={() => saveLimits(delegation)}
									disabled={busy[delegation.id] === true}
									class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-40"
									data-testid="delegation-save-tokens">Save limits</button
								>
								<!-- ── The re-consent path, finally offered ──────────
								     `consent_hash` is recomputed and compared on every
								     fire, and it folds in the workflow definition plus
								     the extension's flattened grants. ez-factory is
								     BUNDLED, so its workflows ship inside the app
								     image: any release that edits one of its
								     `*.workflow.yaml` files, changes its permissions
								     block, or changes a referenced agent's
								     capabilities invalidates every delegation on it
								     and parks the next fire `consent-stale`.

								     Two places on this page already tell people to
								     "grant it again" and neither offered a way to.
								     This one fills the grant form from the row's own
								     four fields and stops — the dialog still has to
								     be opened, the bounds still have to be typed, and
								     Approve still has to be pressed, because the
								     capability set may be exactly what changed. -->
								<button
									type="button"
									onclick={() => grantAgain(delegation)}
									disabled={busy[delegation.id] === true}
									class="ml-auto rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-40"
									data-testid="delegation-grant-again">Grant this again</button
								>
								<button
									type="button"
									onclick={() => revoke(delegation)}
									disabled={busy[delegation.id] === true}
									class="rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-[var(--color-text-primary)] transition-colors hover:bg-red-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:opacity-40"
									data-testid="delegation-revoke">Revoke</button
								>
							</div>

							{#if rowMessage[delegation.id]}
								{@const message = rowMessage[delegation.id]}
								<p
									class="mt-2 text-xs {message.tone === 'error'
										? 'text-[var(--color-text-primary)] font-medium'
										: 'text-[var(--color-text-secondary)]'}"
									data-testid="delegation-message"
								>
									{message.text}
								</p>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- ── Jobs running as me ───────────────────────────────────────── -->
		<section>
			<h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Jobs running as me</h3>
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">
				Runs an extension started under one of your delegations, including ones you have since
				revoked.
			</p>
			<!-- ── The non-firing denials, said out loud ────────────────────
			     A fire blocked BEFORE dispatch returns a deny code and creates
			     no `workflow_runs` row (rungs D7-D10,
			     `src/extensions/workflows-handler.ts`), so it can never appear
			     in the list below. Leaving that unsaid is the worst version of
			     this page: a job that has been blocked every night for a week
			     looks exactly like a job that was never triggered.

			     This is a STATEMENT and not a feed on purpose. Surfacing those
			     denials here is not possible on today's data for the arm that
			     needs it most: a `service`-kind denial is audited through
			     `auditOwnerless` (`workflows-handler.ts:2038-2070`), which
			     writes `audit_log` with `user_id = NULL`, `target =
			     <extensionId>` and a metadata bag carrying only the workflow
			     NAME and the deny code — no `delegation_id` and no consenter.
			     Two people who each consented to a job on the same extension
			     and workflow produce indistinguishable rows, so a
			     "denials for MY delegations" read cannot be built from it
			     without inventing an attribution nobody recorded. D10 (the
			     account's daily token cap) is `service`-ONLY by construction,
			     so it is exactly the rung with the least attributable trail.
			     The honest move is to name the gap and point at what IS
			     reachable, not to render a feed that is silently wrong about
			     whose job it is describing. -->
			<p
				class="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-2 text-xs text-[var(--color-text-secondary)]"
				data-testid="delegated-runs-blocked-note"
			>
				A job blocked before it starts is not listed here — it never ran, so there is no run to
				show. That covers a job over its daily run limit, one whose service account has spent its
				daily tokens, and one whose workflow the principal can no longer reach. The first sign is
				a delegation above going quiet: if one stopped, the reason is on its own row. An
				administrator can see every blocked attempt in the admin audit log.
			</p>
			{#if runs.length === 0}
				<p class="mt-2 text-[var(--color-text-muted)]" data-testid="delegated-runs-empty">
					Nothing has run on your behalf yet.
				</p>
			{:else}
				<div class="mt-3 space-y-2">
					{#each runs as run (run.id)}
						{@const status = describeRunStatus(run.status)}
						<a
							href="/workflows/runs/{run.id}"
							class="block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3 transition-colors hover:border-[var(--color-text-muted)]"
							data-testid="delegated-run-row"
						>
							<div class="flex flex-wrap items-center gap-2 text-xs">
								<span class="font-medium text-[var(--color-text-primary)]"
									>{run.workflowName}</span
								>
								<span
									class="rounded px-1.5 py-0.5 font-medium {status.tone === 'error'
										? 'bg-red-500/15 text-[var(--color-text-primary)]'
										: status.tone === 'warn'
											? 'bg-amber-500/20 text-[var(--color-text-primary)]'
											: status.tone === 'ok'
												? 'bg-green-500/15 text-[var(--color-text-primary)]'
												: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]'}"
									data-testid="delegated-run-status">{status.text}</span
								>
								<span class="text-[var(--color-text-muted)]" data-testid="delegated-run-principal"
									>{describeRunPrincipal(run, accountsById)}</span
								>
								<span class="ml-auto text-[var(--color-text-muted)]" title={run.startedAt} data-testid="delegated-run-time"
									>{describeRunTime(run.startedAt, new Date())}</span
								>
							</div>
							{#if run.error}
								<p class="mt-1 text-xs font-medium text-[var(--color-text-primary)]" data-testid="delegated-run-error">
									{run.error}
								</p>
							{/if}
							{#if run.suspendedReason}
								<!-- The classifier keys on `suspended_reason`, which is the
								     vocabulary this field actually carries — the run row is
								     the only thing a park leaves behind, and it never
								     carries a DELEGATION_* deny code. An unrecognised
								     reason falls back to the raw value rather than being
								     guessed at. -->
								<p
									class="mt-1 text-xs text-[var(--color-text-secondary)]"
									data-testid="delegated-run-suspended"
								>
									{describeRunStopReason(run.suspendedReason) ?? run.suspendedReason}
								</p>
							{/if}
						</a>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>

{#if reviewing && draftExtension}
	<DelegationConsentDialog
		extensionId={draftExtension.id}
		extensionName={draftExtension.name}
		jobRef={draftJobRef.trim()}
		workflowName={draftWorkflowName}
		triggerKind={draftTriggerKind}
		{serviceAccounts}
		onclose={() => (reviewing = false)}
		ondone={(delegation) => {
			reviewing = false;
			granting = false;
			draftJobRef = "";
			// The note described a form that no longer exists; leaving it up
			// would credit the link for a grant that has already happened.
			prefill = null;
			// Prepended rather than refetched: the row the server just
			// returned IS the authoritative one, and a refetch here would
			// race the write it is confirming.
			delegations = [delegation, ...delegations];
			rowMessage = {
				...rowMessage,
				[delegation.id]: { tone: "ok", text: "Approved. This job can now start runs on its own." },
			};
		}}
	/>
{/if}
