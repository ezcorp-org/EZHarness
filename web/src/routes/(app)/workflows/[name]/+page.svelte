<script lang="ts">
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { store, refreshWorkflows } from "$lib/stores.svelte.js";
	import { triggerWorkflowRun, deleteWorkflow, updateWorkflow, forkWorkflow } from "$lib/api.js";
	import {
		statusColor,
		kindLabel,
		runErrorText,
		modelBindingLabel,
		stepModelBinding,
		resolvedModelLabel,
	} from "$lib/workflow-run-display.js";
	import { duplicateName } from "$lib/workflow-builder-logic.js";
	import { inputClass } from "$lib/styles.js";
	import WorkflowBuilder from "$lib/components/WorkflowBuilder.svelte";

	let workflowName = $derived(page.params.name);
	let workflow = $derived(store.workflows.find((w) => w.name === workflowName));
	let runs = $derived(store.workflowRuns.filter((r) => r.workflowName === workflowName));

	// Server-resolved by the ownership ladder's `edit` rung — `source === "db"`
	// AND (admin, or the owner of a `private`/`project` row). A `system` row is
	// admin-only. Gating on it means Edit/Delete are never painted on a request
	// that would 403 (someone else's workflow) or 404 (a YAML/extension asset —
	// a file on disk, with nothing to write).
	let canEdit = $derived(workflow?.canEdit === true);

	let inputText = $state("{}");
	let submitting = $state(false);
	let errorMsg = $state("");

	// ── Inline editing ──────────────────────────────────────────────
	// The editor replaces the step list IN PLACE rather than living on its
	// own route: authoring a workflow is a fix→save→run loop (refs resolve
	// strictly and throw on a miss), and a separate page would cost two
	// navigations per lap and discard the JSON input already typed below.
	let editing = $state(false);
	let editSubmitting = $state(false);
	let editErrorMsg = $state("");

	function startEditing() {
		editErrorMsg = "";
		editing = true;
	}

	function cancelEditing() {
		editing = false;
		editErrorMsg = "";
	}

	async function handleEditSubmit(data: Record<string, unknown>) {
		if (!workflowName) return;
		editSubmitting = true;
		editErrorMsg = "";
		try {
			const saved = await updateWorkflow(workflowName, data);
			await refreshWorkflows();
			editing = false;
			// A rename moves the resource: this page is keyed by name, so
			// staying put would show "not found" for the name we just freed.
			const newName = saved?.name ?? (data.name as string | undefined);
			if (newName && newName !== workflowName) goto(`/workflows/${encodeURIComponent(newName)}`);
		} catch (e) {
			editErrorMsg = e instanceof Error ? e.message : "Failed to update workflow";
		} finally {
			editSubmitting = false;
		}
	}

	// Inline click-to-confirm for the destructive delete. We deliberately do
	// NOT use native `window.confirm()`: browsers silently suppress repeated
	// page dialogs (and some embedded/webview contexts block them outright), so
	// `confirm()` returns false with no visible prompt and Delete becomes a
	// silent no-op (see PR #112). The two-step confirm mirrors the codebase's
	// existing dialog-free pattern: the first click arms a "Confirm delete?"
	// affordance that auto-resets, a second click performs the delete.
	const DELETE_CONFIRM_MS = 3000;
	let deleteConfirming = $state(false);
	let deleteConfirmTimer: ReturnType<typeof setTimeout> | undefined;
	let deleteErrorMsg = $state("");

	// ── Duplicate: ONE copy affordance ──────────────────────────────
	// There were two — a client-side "Duplicate" that navigated to a
	// prefilled create form, and a server-side "Fork" that made the row
	// immediately. The product owner ruled one verb, and this is it.
	//
	// The SERVER implementation survived because it is the one that carries
	// things the client copy could not: `forked_from` provenance (rendered
	// on the editor as "copied from …"), and the collision rule for the
	// globally-unique `name`. What survived from Duplicate is its BEHAVIOUR
	// — you decide before anything is written. That is why this is a panel
	// and not a bare button: the row is still created server-side, but the
	// name and the audience are chosen first.
	//
	// Offered for EVERY workflow, manageable or not. That is deliberate and
	// load-bearing: it is the only productive action on a read-only YAML
	// demo, which otherwise dead-ends. Copying something you may read is
	// exactly what a copy verb is for, so it gates on nothing.
	let copying = $state(false);
	let copyName = $state("");
	// `private` is the route's default too, and the two agree on purpose —
	// a copy is yours until you widen it. `project` is offered beside it
	// with what it ACTUALLY means spelled out: the platform has no
	// membership model, so that tier is every account on this instance.
	let copyVisibility = $state<"private" | "project">("private");
	let copySubmitting = $state(false);
	let copyErrorMsg = $state("");

	// One class for every non-destructive action pill. Repeated inline five
	// times before, which is how the row drifted into five identical-looking
	// buttons with no way to keep them consistent when one changed.
	const ACTION_BTN =
		"rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)] disabled:opacity-50";

	// A DISCLOSURE toggle, not a one-way door. The button was `disabled`
	// while its own panel was open, which — looked at rather than reasoned
	// about — paints a greyed-out pill that reads "this action is
	// unavailable" at exactly the moment the user is using it. It is the
	// control that owns the panel, so it closes it too, and `aria-expanded`
	// says which state it is in.
	function toggleCopy() {
		if (!workflowName) return;
		if (copying) {
			cancelCopy();
			return;
		}
		copyErrorMsg = "";
		// The same `-copy` suffix the old create-form prefill used, so the
		// proposed name does not collide in the ordinary case and the user
		// is not handed a server-chosen `-2` they never asked for.
		copyName = duplicateName(workflowName);
		copyVisibility = "private";
		copying = true;
	}

	function cancelCopy() {
		copying = false;
		copyErrorMsg = "";
	}

	async function handleCopySubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!workflowName) return;
		copySubmitting = true;
		copyErrorMsg = "";
		try {
			// The route returns the FINAL name: `workflow_definitions.name` is
			// globally unique, so a copy onto an already-taken name is suffixed
			// server-side and the user is taken to whatever it ended up called.
			const copy = await forkWorkflow(workflowName, {
				projectId: store.activeProjectId,
				name: copyName.trim(),
				visibility: copyVisibility,
			});
			refreshWorkflows();
			await goto(`/workflows/${encodeURIComponent(copy.name)}/edit`);
		} catch (e) {
			copyErrorMsg = e instanceof Error ? e.message : "Failed to duplicate workflow";
		} finally {
			copySubmitting = false;
		}
	}

	async function handleRun() {
		if (!workflowName) return;
		submitting = true;
		errorMsg = "";
		try {
			const input = JSON.parse(inputText);
			await triggerWorkflowRun(workflowName, input, store.activeProjectId);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to run workflow";
		} finally {
			submitting = false;
		}
	}

	function handleDeleteClick() {
		if (!workflowName) return;
		if (!deleteConfirming) {
			// First click arms the confirm; auto-reset after the window.
			deleteConfirming = true;
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmTimer = setTimeout(() => {
				deleteConfirming = false;
			}, DELETE_CONFIRM_MS);
			return;
		}
		// Second click within the window performs the delete.
		if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
		deleteConfirming = false;
		void performDelete();
	}

	async function performDelete() {
		if (!workflowName) return;
		deleteErrorMsg = "";
		try {
			await deleteWorkflow(workflowName);
		} catch (e) {
			// A failed DELETE was previously an unhandled rejection with no
			// user feedback — surface it like handleRun does.
			deleteErrorMsg = e instanceof Error ? e.message : "Failed to delete workflow";
			return;
		}
		refreshWorkflows();
		goto("/workflows");
	}

</script>

<div class="space-y-6">
	<div>
		<a href="/workflows" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">&larr; Workflows</a>
	</div>

	{#if workflow}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<div class="flex items-start justify-between gap-3">
				<div>
					<h2 class="mb-2 text-2xl font-bold text-[var(--color-text-primary)]">
						{editing ? `Editing ${workflow.name}` : workflow.name}
					</h2>
					{#if workflow.description && !editing}
						<p class="mb-4 text-[var(--color-text-secondary)]">{workflow.description}</p>
					{/if}
				</div>
				<!-- FOUR affordances share this row — it was five until Fork and
				     Duplicate collapsed into one — so it stays GROUPED rather than
				     flat: edit actions, then the copy action, then the destructive
				     one behind a divider. Flat, they read as interchangeable pills
				     and the red Delete sits flush against a benign button.

				     The two editors are both deliberate — the INLINE one for a
				     quick step tweak without leaving the page, and the standalone
				     /edit route for the YAML tab and dry run — so the inline one
				     says "Edit steps" rather than a bare "Edit", which was
				     indistinguishable from "Full editor" beside it.

				     Every WRITE affordance gates on the same server-computed flag —
				     an ungated Edit on a read-only YAML demo is a button whose only
				     outcome is a 404. Duplicate stays ungated: copying something
				     you can read is exactly what it is for, and on a read-only
				     demo it is the ONLY thing that works. -->
				{#if !editing}
					<div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-2">
						{#if canEdit}
							<button
								onclick={startEditing}
								data-testid="workflow-edit"
								title="Edit the steps inline, without leaving this page"
								class={ACTION_BTN}
							>
								Edit steps
							</button>
							<a
								href="/workflows/{workflowName}/edit"
								data-testid="edit-workflow"
								title="Open the standalone editor — YAML view and dry run"
								class={ACTION_BTN}
							>
								Full editor
							</a>
						{/if}
						<button
							onclick={toggleCopy}
							aria-expanded={copying}
							data-testid="workflow-duplicate"
							title="Make your own copy — you name it and choose who can see it before it is created"
							class={ACTION_BTN}
						>
							Duplicate
						</button>
						{#if canEdit}
							<!-- Divider + wider gap: the only destructive control in the
							     row must not be one slipped click away from Duplicate. -->
							<span
								aria-hidden="true"
								data-testid="workflow-actions-divider"
								class="mx-1 hidden h-5 w-px bg-[var(--color-border)] sm:block"
							></span>
							<button
								onclick={handleDeleteClick}
								data-confirming={deleteConfirming}
								data-testid="workflow-delete"
								title="Delete this workflow — click twice to confirm"
								class="rounded-md bg-red-600/80 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-red-500"
							>
								{deleteConfirming ? "Confirm delete?" : "Delete"}
							</button>
						{/if}
					</div>
				{/if}
			</div>

			<!-- The copy is COMMITTED here, not by the button above. The old
			     Fork wrote a row the instant it was clicked and stamped it
			     `project` — readable and runnable by every account on the
			     instance — before the user had decided anything. Naming the
			     copy and choosing its audience are the two decisions worth
			     stopping for, so they happen in front of the user and the
			     write happens after. -->
			{#if copying && !editing}
				<form
					class="mt-4 mb-4 space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
					data-testid="workflow-duplicate-panel"
					onsubmit={handleCopySubmit}
				>
					<h3 class="text-sm font-semibold text-[var(--color-text-primary)]">
						Duplicate {workflow.name}
					</h3>
					<div>
						<label
							class="mb-1 block text-sm text-[var(--color-text-secondary)]"
							for="duplicate-name">Name</label
						>
						<input
							id="duplicate-name"
							bind:value={copyName}
							data-testid="duplicate-name"
							class={inputClass}
							required
						/>
						<p class="mt-1 text-xs text-[var(--color-text-muted)]">
							Workflow names are unique across the whole instance. If this one is taken, a number
							is added and you land on the copy under its real name.
						</p>
					</div>
					<div>
						<label
							class="mb-1 block text-sm text-[var(--color-text-secondary)]"
							for="duplicate-visibility">Who can see and run it</label
						>
						<select
							id="duplicate-visibility"
							bind:value={copyVisibility}
							data-testid="duplicate-visibility"
							class={inputClass}
						>
							<option value="private">Only me (and admins)</option>
							<option value="project">Everyone with an account here</option>
						</select>
						<p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="duplicate-visibility-note">
							{copyVisibility === "private"
								? "Nobody else can see or run your copy. You can widen this later from the editor."
								: "This instance has no per-project membership, so “project” means every account on it — not just your team."}
						</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="submit"
							disabled={copySubmitting}
							data-testid="duplicate-confirm"
							class="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
						>
							{copySubmitting ? "Duplicating…" : "Create copy"}
						</button>
						<button
							type="button"
							onclick={cancelCopy}
							disabled={copySubmitting}
							data-testid="duplicate-cancel"
							class={ACTION_BTN}
						>
							Cancel
						</button>
					</div>
					{#if copyErrorMsg}
						<p class="text-sm text-red-400" data-testid="duplicate-error">{copyErrorMsg}</p>
					{/if}
				</form>
			{/if}

			{#if deleteErrorMsg}
				<p class="mb-3 text-sm text-red-400" data-testid="delete-error">{deleteErrorMsg}</p>
			{/if}

			{#if editing}
				<WorkflowBuilder
					initial={workflow as unknown as Record<string, unknown>}
					agents={store.agents}
					onsubmit={handleEditSubmit}
					oncancel={cancelEditing}
					submitting={editSubmitting}
					submitLabel="Save"
				/>
				{#if editErrorMsg}
					<p class="mt-3 text-sm text-red-400" data-testid="workflow-edit-error">{editErrorMsg}</p>
				{/if}
			{:else}
			<h3 class="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">Steps</h3>
			<div class="space-y-2" data-testid="workflow-steps-view">
				{#each workflow.steps as step, idx}
					{@const kind = step.kind ?? "agent"}
					{@const modelLabel = kind === "agent" ? modelBindingLabel(stepModelBinding(step, workflow)) : ""}
					<div class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-xs text-[var(--color-text-muted)]">{idx + 1}.</span>
							<span class="font-medium text-[var(--color-text-primary)]">{step.name}</span>
							<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{kindLabel(kind)}</span>
							{#if kind === "agent"}
								<span class="text-[var(--color-text-muted)]">&rarr;</span>
								<span class="text-blue-400">{step.agent}</span>
							{/if}
							{#if kind === "tool"}
								<span class="text-[var(--color-text-muted)]">&rarr;</span>
								<span class="font-mono text-xs text-teal-400">{step.tool}</span>
							{/if}
							{#if kind === "workflow"}
								<span class="text-[var(--color-text-muted)]">&rarr;</span>
								<a
									class="text-blue-400 underline decoration-dotted underline-offset-2 hover:text-blue-300"
									data-testid="step-nested-workflow"
									href="/workflows/{encodeURIComponent(step.workflow ?? '')}"
								>{step.workflow}</a>
							{/if}
							{#if step.when}
								<span
									class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
									data-testid="step-when"
									title={step.skipDependents === false
										? "Conditional — skipped if the condition is false; its dependents still run"
										: "Conditional — skipped if the condition is false, along with its dependents"}
								>conditional{step.skipDependents === false ? " (dependents still run)" : ""}</span>
							{/if}
							{#if modelLabel}
								<span
									class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-teal-300"
									data-testid="step-model"
									title={step.model ? "Per-step model override" : "Inherited from the workflow default model"}
								>{modelLabel}</span>
							{/if}
							{#if step.loop}
								<span class="text-xs text-purple-400">loop &times;{step.loop.maxIterations}{step.loop.until ? " (until)" : ""}</span>
							{/if}
						</div>
						{#if step.input && Object.keys(step.input).length > 0}
							<div class="mt-1 text-xs text-[var(--color-text-muted)]">
								Input: {Object.entries(step.input).map(([k, v]) => `${k}=${v}`).join(", ")}
							</div>
						{/if}
						{#if step.output && Object.keys(step.output).length > 0}
							<div class="mt-1 text-xs text-[var(--color-text-muted)]">
								Output: {Object.entries(step.output).map(([k, v]) => `${k}=${v}`).join(", ")}
							</div>
						{/if}
						{#if step.dependsOn && step.dependsOn.length > 0}
							<div class="mt-1 text-xs text-[var(--color-text-muted)]">
								Depends on: {step.dependsOn.join(", ")}
							</div>
						{/if}
					</div>
				{/each}
			</div>
			{/if}
		</div>

		<!-- Hidden while editing: Run posts the SAVED definition, so leaving it
		     live next to unsaved edits invites running the old graph and
		     reading the result as if it reflected the change. Run History
		     stays visible below — it is what you are editing against. -->
		{#if !editing}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Run Workflow</h3>
			<label class="mb-2 block text-sm text-[var(--color-text-secondary)]" for="workflow-input">JSON Input</label>
			<textarea
				id="workflow-input"
				bind:value={inputText}
				class="mb-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				rows="3"
				placeholder={'{"key": "value"}'}
			></textarea>
			{#if errorMsg}
				<p class="mb-3 text-sm text-red-400">{errorMsg}</p>
			{/if}
			<button
				onclick={handleRun}
				disabled={submitting}
				class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
			>
				{submitting ? "Running..." : "Run Workflow"}
			</button>
		</div>
		{/if}

		{#if runs.length > 0}
			<section>
				<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Run History</h3>
				<div class="space-y-2">
					{#each runs as run (run.id)}
						<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">{run.id.slice(0, 8)}</span>
								<span class="rounded bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs {statusColor(run.status)}">{run.status}</span>
							</div>
							{#if runErrorText(run)}
								<p class="mt-2 text-xs {statusColor(run.status)}" data-testid="run-error">{runErrorText(run)}</p>
							{/if}
							{#if run.steps.length > 0}
								<div class="mt-2 space-y-1">
									{#each run.steps as step}
										{@const ranOn = resolvedModelLabel(step)}
										<!-- A skipped step is dimmed and struck through, so the eye
										     separates "never ran" from "ran and failed" before it
										     reads a single word. Failure is the only thing that
										     should ever look alarming here. -->
										<div
											class="text-xs text-[var(--color-text-secondary)]{step.status === 'skipped' ? ' opacity-60' : ''}"
											data-testid={step.status === "skipped" ? "run-step-skipped" : "run-step"}
										>
											<span class={step.status === "skipped" ? "line-through" : ""}>{step.stepName}</span>: <span class="{statusColor(step.status)}">{step.status}</span>{#if step.skippedReason} <span class="text-[var(--color-text-muted)]" data-testid="step-skipped-reason">— {step.skippedReason}</span>{/if}{#if step.iterations} <span class="text-[var(--color-text-muted)]">({step.iterations} iteration{step.iterations !== 1 ? "s" : ""})</span>{/if}{#if ranOn} <span class="text-teal-300" data-testid="step-ran-on">on {ranOn}</span>{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{:else}
			<p class="text-[var(--color-text-muted)]">No runs yet — trigger one above.</p>
		{/if}
	{:else}
		<p class="text-[var(--color-text-muted)]">Workflow "{workflowName}" not found.</p>
	{/if}
</div>
