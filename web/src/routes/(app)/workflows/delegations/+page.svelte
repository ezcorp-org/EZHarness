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
	import { onMount } from "svelte";
	import { store } from "$lib/stores.svelte.js";
	import DelegationConsentDialog from "$lib/components/DelegationConsentDialog.svelte";
	import {
		describeDelegationState,
		describeRunPrincipal,
		describeRunTime,
		describeRunStatus,
		loadDelegatedRuns,
		loadDelegations,
		loadServiceAccounts,
		patchDelegationTokens,
		revokeDelegation,
		type Delegation,
		type DelegatedRun,
		type ServiceAccountOption,
	} from "$lib/workflow-delegations-logic";

	let delegations = $state<Delegation[]>([]);
	let runs = $state<DelegatedRun[]>([]);
	let serviceAccounts = $state<ServiceAccountOption[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	/** delegationId → the edited token ceiling, while it is being edited. */
	let editingTokens = $state<Record<string, number | null>>({});
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

		const [listed, ran] = await Promise.all([loadDelegations(), loadDelegatedRuns()]);
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

		// Admin-only, and that is fine — the names are used to label a
		// service-account run, and an ordinary user simply sees the generic
		// label instead of a bare id.
		const accounts = await loadServiceAccounts();
		serviceAccounts = accounts.ok ? accounts.value.accounts : [];
		await loadDelegatableExtensions();
		loading = false;
	}

	onMount(load);

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

	async function saveTokens(delegation: Delegation) {
		const next = editingTokens[delegation.id];
		if (next === null || next === undefined || !Number.isInteger(next) || next <= 0) {
			rowMessage = {
				...rowMessage,
				[delegation.id]: { tone: "error", text: "Enter a whole number above zero." },
			};
			return;
		}
		busy = { ...busy, [delegation.id]: true };
		const result = await patchDelegationTokens(delegation.id, next);
		busy = { ...busy, [delegation.id]: false };
		if (!result.ok) {
			rowMessage = { ...rowMessage, [delegation.id]: { tone: "error", text: result.message } };
			return;
		}
		delegations = delegations.map((d) =>
			d.id === delegation.id ? result.value.delegation : d,
		);
		editingTokens = { ...editingTokens, [delegation.id]: null };
		rowMessage = {
			...rowMessage,
			[delegation.id]: { tone: "ok", text: "Token limit updated." },
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
		>
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
							<option value="cron">On a schedule</option>
							<option value="webhook">On a webhook</option>
							<option value="event">On an event</option>
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
								<button
									type="button"
									onclick={() => saveTokens(delegation)}
									disabled={busy[delegation.id] === true}
									class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-40"
									data-testid="delegation-save-tokens">Save limit</button
								>
								<span class="text-[10px] text-[var(--color-text-muted)]"
									>{delegation.maxRunsPerDay} runs/day</span
								>
								<button
									type="button"
									onclick={() => revoke(delegation)}
									disabled={busy[delegation.id] === true}
									class="ml-auto rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-[var(--color-text-primary)] transition-colors hover:bg-red-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:opacity-40"
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
							{:else if run.suspendedReason}
								<p class="mt-1 text-xs font-medium text-[var(--color-text-secondary)]" data-testid="delegated-run-suspended">
									{run.suspendedReason}
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
