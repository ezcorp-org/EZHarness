<script lang="ts">
	import { GitBranch, RefreshCw, Wrench } from "lucide-svelte";
	import type { FactoryRunDetails, FactoryRunSummary, FactoryRunRevisionBody, FactoryTransportValue } from "@ezcorp/factory-sdk/types";
	import { FactoryApiClient, FactoryApiClientError, type FactoryRunControlApi } from "./client";

	let { projectId, api = new FactoryApiClient() }: { projectId: string; api?: FactoryRunControlApi } = $props();

	/** Only a live run can take a control; a terminal one needs a new run, not a repair. */
	const CONTROLLABLE = ["queued", "running", "waiting"] as const;

	let runs = $state<readonly FactoryRunSummary[]>([]);
	let selected = $state<FactoryRunDetails | null>(null);
	let action = $state<"repair" | "replan">("repair");
	let nodeId = $state("");
	let reason = $state("");
	let replacementId = $state("");
	let replacementVersion = $state("");
	let replacementDigest = $state("");
	let parameters = $state("{}");
	let loading = $state(false);
	let submitting = $state(false);
	let errorMessage = $state("");
	let receiptMessage = $state("");
	let requestVersion = 0;

	$effect(() => {
		const currentProject = projectId;
		const version = ++requestVersion;
		runs = [];
		selected = null;
		errorMessage = "";
		receiptMessage = "";
		if (currentProject) void load(currentProject, version);
	});

	function describe(error: unknown): string {
		if (error instanceof FactoryApiClientError) {
			if (error.code === "factory_control_stale") return "The run moved on while you were editing. Its current revision is loaded; review and send again.";
			if (error.code === "factory_control_widening") return "That replacement widens the run's authority. A wider contract needs a new authorized run.";
			if (error.code === "factory_control_invalid") return "That control cannot apply to this node right now.";
			return error.message;
		}
		return error instanceof Error ? error.message : "The run control service is unavailable.";
	}

	async function load(currentProject = projectId, version = ++requestVersion): Promise<void> {
		if (!currentProject) return;
		loading = true;
		errorMessage = "";
		try {
			const page = await api.listRuns(currentProject, { limit: 50 });
			if (version !== requestVersion || currentProject !== projectId) return;
			runs = page.items;
		} catch (error) {
			if (version === requestVersion) errorMessage = describe(error);
		} finally {
			if (version === requestVersion) loading = false;
		}
	}

	async function select(summary: FactoryRunSummary): Promise<void> {
		errorMessage = "";
		receiptMessage = "";
		try {
			selected = await api.getRun(projectId, summary.runId);
		} catch (error) {
			selected = null;
			errorMessage = describe(error);
		}
	}

	/** Builds the exact revision body, or reports why the operator's input cannot become one. */
	function revisionBody(): FactoryRunRevisionBody | string {
		if (!nodeId.trim()) return "Name the node this control replaces.";
		let parsed: unknown;
		try { parsed = JSON.parse(parameters || "{}"); } catch { return "The input override is not valid JSON."; }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "The input override must be a JSON object of port names.";
		const overrides = parsed as Record<string, FactoryTransportValue>;
		const trimmedReason = reason.trim();
		const common = { nodeId: nodeId.trim(), parameters: overrides, ...(trimmedReason ? { reason: trimmedReason } : {}) };
		if (action === "repair") return { action: "repair", ...common };
		if (!replacementId.trim() || !replacementVersion.trim() || !replacementDigest.trim()) return "A replan needs the exact published child id, version, and digest.";
		return { action: "replan", ...common, replacement: { id: replacementId.trim(), version: replacementVersion.trim(), digest: replacementDigest.trim() } };
	}

	async function submit(): Promise<void> {
		const current = selected;
		if (!current) return;
		const body = revisionBody();
		if (typeof body === "string") { errorMessage = body; receiptMessage = ""; return; }
		submitting = true;
		errorMessage = "";
		receiptMessage = "";
		try {
			const receipt = await api.controlRun(projectId, current.runId, current.revision, body);
			// Re-read first: selecting a run clears both banners, so the outcome is written last.
			await select(current);
			await load();
			receiptMessage = `Queued ${body.action} as ${receipt.commandId}.`;
		} catch (error) {
			if (error instanceof FactoryApiClientError && error.code === "factory_control_stale") await select(current);
			errorMessage = describe(error);
		} finally {
			submitting = false;
		}
	}
</script>

<section class="run-controls" aria-labelledby="run-controls-title" data-testid="factory-run-controls">
	<header>
		<div class="title-mark"><Wrench size={18} /></div>
		<div>
			<p>Bounded remediation</p>
			<h2 id="run-controls-title">Run controls</h2>
		</div>
		<span class="count" aria-label={`${runs.length} factory runs`}>{runs.length}</span>
		<button class="refresh" aria-label="Refresh factory runs" disabled={loading || !projectId} onclick={() => load()}><span class:spin={loading}><RefreshCw size={15} /></span></button>
	</header>

	{#if errorMessage}<div class="control-error" role="alert">{errorMessage}</div>{/if}
	{#if receiptMessage}<div class="control-receipt" role="status">{receiptMessage}</div>{/if}

	{#if loading && runs.length === 0}
		<p class="empty" aria-live="polite">Reading current runs…</p>
	{:else if runs.length === 0}
		<p class="empty">This project has no factory runs yet.</p>
	{:else}
		<ul class="runs">
			{#each runs as run (run.runId)}
				<li>
					<button
						class="run"
						class:active={selected?.runId === run.runId}
						aria-pressed={selected?.runId === run.runId}
						disabled={!CONTROLLABLE.includes(run.status as (typeof CONTROLLABLE)[number])}
						onclick={() => select(run)}
					>
						<code>{run.runId}</code>
						<small>{run.factoryId} · {run.factoryVersion} · rev {run.revision}</small>
						<span class="status" data-status={run.status}>{run.status}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if selected}
		<form class="control-form" aria-label="Run control" onsubmit={event => { event.preventDefault(); void submit(); }}>
			<p class="selected">Controlling <code>{selected.runId}</code> at revision {selected.revision}{selected.error ? ` · ${selected.error.code}` : ""}</p>
			<div class="actions" role="group" aria-label="Control action">
				<button type="button" class:chosen={action === "repair"} aria-pressed={action === "repair"} onclick={() => { action = "repair"; }}><Wrench size={14} /> Repair</button>
				<button type="button" class:chosen={action === "replan"} aria-pressed={action === "replan"} onclick={() => { action = "replan"; }}><GitBranch size={14} /> Replan</button>
			</div>
			<label>Node<input bind:value={nodeId} placeholder="generate-private-candidate" /></label>
			<label>Reason<input bind:value={reason} placeholder="Rejected: the protected test is missing" /></label>
			{#if action === "replan"}
				<label>Child factory<input bind:value={replacementId} placeholder="reference.code.v1" /></label>
				<label>Child version<input bind:value={replacementVersion} placeholder="1.1.0" /></label>
				<label>Child digest<input bind:value={replacementDigest} placeholder="sha256:…" /></label>
			{/if}
			<label>Input override<textarea bind:value={parameters} rows="3" spellcheck="false"></textarea></label>
			<button class="submit" type="submit" disabled={submitting}>{submitting ? "Sending…" : action === "repair" ? "Request repair" : "Request replan"}</button>
		</form>
	{/if}
</section>

<style>
	.run-controls { border-bottom: 1px solid var(--color-border); background: color-mix(in srgb, var(--color-surface-secondary) 82%, var(--color-accent) 3%); color: var(--color-text-primary); }
	header { display: flex; min-height: 58px; align-items: center; gap: 10px; padding: 8px 28px; }
	header p { margin: 0 0 2px; color: var(--color-accent); font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
	header h2 { margin: 0; font-size: 15px; font-weight: 600; }
	.title-mark { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 9px; background: color-mix(in srgb, var(--color-accent) 16%, transparent); color: var(--color-accent); }
	.count { margin-left: auto; border-radius: 999px; padding: 2px 9px; background: color-mix(in srgb, var(--color-accent) 14%, transparent); color: var(--color-accent); font-family: var(--font-mono); font-size: 11px; }
	.refresh { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid var(--color-border); border-radius: 8px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.refresh:disabled { cursor: default; opacity: .5; }
	.spin { display: grid; animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.control-error, .control-receipt { margin: 0 28px 10px; border-radius: 8px; padding: 8px 12px; font-size: 12px; }
	.control-error { border: 1px solid color-mix(in srgb, var(--color-danger) 40%, transparent); background: color-mix(in srgb, var(--color-danger) 12%, transparent); color: var(--color-danger); }
	.control-receipt { border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent); background: color-mix(in srgb, var(--color-accent) 10%, transparent); color: var(--color-accent); }
	.empty { margin: 0; padding: 0 28px 16px; color: var(--color-text-secondary); font-size: 12px; }
	.runs { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0 28px 14px; list-style: none; }
	.run { display: grid; width: 100%; grid-template-columns: 1fr auto; gap: 2px 12px; border: 1px solid var(--color-border); border-radius: 10px; padding: 8px 12px; background: var(--color-surface-primary); color: inherit; text-align: left; cursor: pointer; }
	.run:disabled { cursor: default; opacity: .55; }
	.run.active { border-color: var(--color-accent); }
	.run code { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
	.run small { grid-column: 1; color: var(--color-text-secondary); font-size: 11px; }
	.status { grid-row: 1 / span 2; align-self: center; border-radius: 999px; padding: 2px 10px; background: color-mix(in srgb, var(--color-text-secondary) 14%, transparent); font-family: var(--font-mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
	.status[data-status="waiting"] { background: color-mix(in srgb, var(--color-accent) 18%, transparent); color: var(--color-accent); }
	.control-form { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--color-border); padding: 14px 28px 18px; }
	.selected { margin: 0; color: var(--color-text-secondary); font-size: 12px; }
	.selected code { font-family: var(--font-mono); }
	.actions { display: flex; gap: 8px; }
	.actions button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--color-border); border-radius: 8px; padding: 6px 12px; background: transparent; color: var(--color-text-secondary); font-size: 12px; cursor: pointer; }
	.actions button.chosen { border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 12%, transparent); color: var(--color-accent); }
	label { display: flex; flex-direction: column; gap: 4px; color: var(--color-text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
	input, textarea { border: 1px solid var(--color-border); border-radius: 8px; padding: 7px 10px; background: var(--color-surface-primary); color: var(--color-text-primary); font-family: var(--font-mono); font-size: 12px; }
	textarea { resize: vertical; }
	.submit { align-self: flex-start; border: 1px solid var(--color-accent); border-radius: 8px; padding: 7px 16px; background: color-mix(in srgb, var(--color-accent) 14%, transparent); color: var(--color-accent); font-size: 12px; font-weight: 600; cursor: pointer; }
	.submit:disabled { cursor: default; opacity: .6; }
</style>
