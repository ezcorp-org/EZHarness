<script lang="ts" module>
	import type { FactoryRunStreamStatus, FactoryStreamState } from "./run-stream";

	/** Plain words for every stream state; none of them claims a status it has not seen. */
	export const FACTORY_STREAM_LABELS: Readonly<Record<FactoryStreamState, string>> = {
		connecting: "Connecting",
		live: "Live",
		lagging: "Live · status catching up",
		"catching-up": "Catching up missed events",
		reconnecting: "Reconnecting",
		offline: "Offline · status may be stale",
		ended: "Finished",
		revoked: "Access ended",
	};

	export function streamSummary(status: FactoryRunStreamStatus): string {
		const parts = [`sequence ${status.applied}`];
		if (status.lag > 0) parts.push(`${status.lag} event${status.lag === 1 ? "" : "s"} not yet in status`);
		if (status.duplicates > 0) parts.push(`${status.duplicates} duplicate${status.duplicates === 1 ? "" : "s"} ignored`);
		if (status.gaps > 0) parts.push(`${status.gaps} gap${status.gaps === 1 ? "" : "s"} recovered`);
		if (status.reconnects > 0) parts.push(`${status.reconnects} reconnect${status.reconnects === 1 ? "" : "s"}`);
		return parts.join(" · ");
	}

	export function formatMicros(value: string): string {
		const micros = BigInt(value);
		const whole = micros / 1_000_000n;
		const fraction = (micros % 1_000_000n).toString().padStart(6, "0").slice(0, 4);
		return `${whole.toLocaleString("en-US")}.${fraction}`;
	}

	export function shortDigest(value: string): string {
		const hex = value.startsWith("sha256:") ? value.slice(7) : value;
		return hex.slice(0, 12);
	}

	/** Appends a page, keeping the first copy of any item that moved between pages while they were read. */
	export function appendUnique<T>(current: readonly T[], next: readonly T[], key: (item: T) => string): readonly T[] {
		const seen = new Set(current.map(key));
		return [...current, ...next.filter(item => !seen.has(key(item)))];
	}

	export function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	}
</script>

<script lang="ts">
	import { AlertTriangle, ArrowUpRight, Boxes, CircleDollarSign, Download, Eye, FileCheck2, GitMerge, Radio, RefreshCw, Rocket, Search, ShieldAlert } from "lucide-svelte";
	import { onDestroy } from "svelte";
	import type { FactoryArtifactResource, FactoryAttemptResource, FactoryChildRunResource, FactoryRunEvent, FactoryRunInspection, FactoryRunStatus, FactoryRunSummary } from "@ezcorp/factory-sdk/types";
	import { FactoryApiClient, FactoryApiClientError, type FactoryRunControlApi, type FactoryRunInspectorApi } from "./client";
	import { FactoryRunStream } from "./run-stream";
	import FactoryArtifactPreview from "./FactoryArtifactPreview.svelte";
	import FactoryRunControls from "./FactoryRunControls.svelte";

	let {
		projectId,
		onOpenInbox,
		initialRunId = null,
		api = new FactoryApiClient(),
	}: {
		projectId: string;
		onOpenInbox: () => void;
		/** Opened once the run list for the project has loaded. */
		initialRunId?: string | null;
		api?: FactoryRunInspectorApi & FactoryRunControlApi;
	} = $props();

	const TERMINAL: ReadonlySet<FactoryRunStatus> = new Set(["succeeded", "failed", "cancelled"]);
	const STATUS_FILTERS: readonly ("" | FactoryRunStatus)[] = ["", "queued", "running", "waiting", "cancelling", "uncertain", "succeeded", "failed", "cancelled"];

	let runs = $state<readonly FactoryRunSummary[]>([]);
	let runsCursor = $state<string | null>(null);
	let statusFilter = $state<"" | FactoryRunStatus>("");
	let loadingRuns = $state(false);
	let listError = $state("");
	let selectedRunId = $state<string | null>(null);
	let trail = $state<string[]>([]);
	let inspection = $state<FactoryRunInspection | null>(null);
	let attempts = $state<readonly FactoryAttemptResource[]>([]);
	let attemptsCursor = $state<string | undefined>(undefined);
	let children = $state<readonly FactoryChildRunResource[]>([]);
	let childrenCursor = $state<string | undefined>(undefined);
	let artifacts = $state<readonly FactoryArtifactResource[]>([]);
	let artifactsCursor = $state<string | undefined>(undefined);
	let attemptSearch = $state("");
	let appliedSearch = $state("");
	let events = $state<readonly FactoryRunEvent[]>([]);
	let stream = $state<FactoryRunStreamStatus | null>(null);
	let detailError = $state("");
	let previewing = $state<FactoryArtifactResource | null>(null);
	let active: FactoryRunStream | null = null;
	let listVersion = 0;
	let initialOpened = false;

	$effect(() => {
		const current = projectId;
		const status = statusFilter;
		void loadRuns(current, status, true);
		return () => { closeStream(); };
	});

	onDestroy(() => closeStream());

	function describe(error: unknown): string {
		if (error instanceof FactoryApiClientError) {
			if (error.status === 403) return "You no longer hold read access to this run.";
			if (error.status === 404) return "This run is not in the selected project.";
			return error.message;
		}
		return error instanceof Error ? error.message : "The factory service is unavailable.";
	}

	async function loadRuns(current: string, status: "" | FactoryRunStatus, reset: boolean): Promise<void> {
		const version = ++listVersion;
		if (reset) { runs = []; runsCursor = null; selectedRunId = null; inspection = null; trail = []; closeStream(); }
		if (!current) return;
		loadingRuns = true;
		listError = "";
		try {
			const page = await api.listRuns(current, { limit: 50, ...(status ? { status } : {}), ...(reset || !runsCursor ? {} : { cursor: runsCursor }) });
			if (version !== listVersion) return;
			runs = reset ? page.items : appendUnique(runs, page.items, item => item.runId);
			runsCursor = page.nextCursor;
			if (initialRunId && !initialOpened) { initialOpened = true; open(initialRunId); }
		} catch (error) {
			if (version === listVersion) listError = describe(error);
		} finally {
			if (version === listVersion) loadingRuns = false;
		}
	}

	function closeStream(): void {
		active?.stop();
		active = null;
	}

	function adopt(next: FactoryRunInspection): void {
		inspection = next;
		attempts = next.attempts.items;
		attemptsCursor = next.attempts.nextCursor;
		children = next.children.items;
		childrenCursor = next.children.nextCursor;
		artifacts = next.artifacts.items;
		artifactsCursor = next.artifacts.nextCursor;
	}

	function open(runId: string, via: "list" | "child" | "trail" = "list"): void {
		closeStream();
		if (via === "list") trail = [];
		else if (via === "child" && selectedRunId) trail = [...trail, selectedRunId];
		else if (via === "trail") {
			// Going up keeps only the ancestors above the target; a parent not on the trail starts a new one.
			const at = trail.indexOf(runId);
			trail = at >= 0 ? trail.slice(0, at) : [];
		}
		selectedRunId = runId;
		inspection = null;
		events = [];
		detailError = "";
		const search = appliedSearch;
		const current = projectId;
		const view = new FactoryRunStream({
			snapshot: () => api.inspectRun(current, runId, search || undefined),
			open: (cursor, signal) => api.openRunEvents(current, runId, cursor, signal),
			onSnapshot: next => { if (active === view) adopt(next); },
			onStatus: status => { if (active === view) stream = status; },
			onEvent: event => { if (active === view) events = [event, ...events].slice(0, 25); },
		});
		active = view;
		stream = view.current;
		void view.run().then(final => {
			if (active !== view || final.state !== "revoked") return;
			// Revoked access leaves nothing behind: no stale status, attempts, or artifacts.
			inspection = null;
			events = [];
			detailError = "Access to this run ended. The view stopped instead of showing stale status.";
		});
	}

	function back(index: number): void {
		open(trail[index]!, "trail");
	}

	async function more(section: "attempts" | "children" | "artifacts"): Promise<void> {
		const runId = selectedRunId;
		const cursor = section === "attempts" ? attemptsCursor : section === "children" ? childrenCursor : artifactsCursor;
		if (!runId || !cursor) return;
		try {
			const page = await api.inspectRunSection(projectId, runId, { section, cursor, limit: 50, ...(section === "attempts" && appliedSearch ? { search: appliedSearch } : {}) });
			if (page.section === "attempts") { attempts = appendUnique(attempts, page.page.items, item => item.attemptId); attemptsCursor = page.page.nextCursor; }
			else if (page.section === "children") { children = appendUnique(children, page.page.items, item => item.runId); childrenCursor = page.page.nextCursor; }
			else { artifacts = appendUnique(artifacts, page.page.items, item => item.artifactId); artifactsCursor = page.page.nextCursor; }
		} catch (error) {
			detailError = describe(error);
		}
	}

	async function filterAttempts(): Promise<void> {
		const runId = selectedRunId;
		if (!runId) return;
		appliedSearch = attemptSearch.trim();
		try {
			const page = await api.inspectRunSection(projectId, runId, { section: "attempts", limit: 50, ...(appliedSearch ? { search: appliedSearch } : {}) });
			if (page.section === "attempts") { attempts = page.page.items; attemptsCursor = page.page.nextCursor; }
		} catch (error) {
			detailError = describe(error);
		}
	}

	async function download(artifact: FactoryArtifactResource): Promise<void> {
		const runId = selectedRunId;
		if (!runId) return;
		try {
			const ticket = await api.artifactTicket(projectId, runId, artifact.artifactId);
			const link = document.createElement("a");
			link.href = ticket.url;
			link.rel = "noopener";
			link.download = "";
			document.body.append(link);
			link.click();
			link.remove();
		} catch (error) {
			detailError = describe(error);
		}
	}

	let run = $derived(inspection?.run ?? null);
	let blockers = $derived(inspection?.blockers ?? []);
	let controllable = $derived(run !== null && !TERMINAL.has(run.status) && run.status !== "cancelling" && run.status !== "uncertain");
	let rejected = $derived((inspection?.acceptance ?? []).filter(item => item.decision === "rejected"));
</script>

<section class="run-inspector" data-testid="factory-run-inspector">
	<aside class="run-list" aria-label="Factory runs">
		<div class="panel-heading">
			<div><span class="panel-index">01</span><h2>Runs</h2></div>
			<button class="icon-button" aria-label="Refresh factory runs" title="Refresh" disabled={loadingRuns || !projectId} onclick={() => loadRuns(projectId, statusFilter, true)}><RefreshCw size={15} /></button>
		</div>
		<label class="filter">
			<span>Status</span>
			<select bind:value={statusFilter} aria-label="Filter runs by status">
				{#each STATUS_FILTERS as status (status)}<option value={status}>{status || "Any status"}</option>{/each}
			</select>
		</label>
		{#if listError}<p class="inline-error" role="alert">{listError}</p>{/if}
		<ul class="runs">
			{#if loadingRuns && runs.length === 0}<li class="empty-copy" aria-live="polite">Reading runs…</li>
			{:else if runs.length === 0}<li class="empty-copy">No runs match this view.</li>{/if}
			{#each runs as item (item.runId)}
				<li>
					<button class="run-row" class:active={selectedRunId === item.runId || trail[0] === item.runId} aria-pressed={selectedRunId === item.runId} onclick={() => open(item.runId)}>
						<span class="status-dot" data-status={item.status}></span>
						<span class="run-copy"><strong title={item.factoryId}>{item.factoryId}</strong><small title={item.runId}>{item.runId}</small></span>
						<span class="chip" data-status={item.status}>{item.status}</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if runsCursor}<button class="more" onclick={() => loadRuns(projectId, statusFilter, false)}>Load more runs</button>{/if}
	</aside>

	<div class="run-detail">
		{#if !selectedRunId}
			<div class="detail-empty">
				<div class="empty-mark"><Radio size={26} /></div>
				<p class="eyebrow">No run selected</p>
				<h2>Choose a run to watch it live.</h2>
				<p>The view takes an authenticated snapshot, then follows the run's committed events in order.</p>
			</div>
		{:else}
			<header class="detail-heading">
				{#if trail.length > 0}
					<nav class="trail" aria-label="Parent runs">
						{#each trail as ancestor, index (ancestor)}
							<button onclick={() => back(index)} title={ancestor}>{index === 0 ? "Root run" : `Parent ${index}`}</button><span aria-hidden="true">/</span>
						{/each}
						<span class="trail-current">Nested run</span>
					</nav>
				{/if}
				<div class="heading-row">
					<div class="heading-copy">
						<p class="eyebrow">{run ? `Run · ${run.status}` : "Run"}</p>
						<h2 title={run?.factoryId ?? selectedRunId}>{run?.factoryId ?? (stream?.state === "revoked" ? "Run unavailable" : "Loading run…")}</h2>
						{#if run}<p class="meta">version {run.factoryVersion} · revision {run.revision} · grant {run.grantRevision}</p>{/if}
					</div>
					{#if stream}
						<div class="stream-badge" data-state={stream.state} role="status" aria-live="polite" data-testid="factory-stream-state">
							<span class="pulse" aria-hidden="true"></span>
							<span><strong>{FACTORY_STREAM_LABELS[stream.state]}</strong><small>{streamSummary(stream)}</small></span>
						</div>
					{/if}
				</div>
				{#if inspection?.parentRunId}
					<button class="link-button" onclick={() => open(inspection!.parentRunId!, "trail")}><ArrowUpRight size={13} /> Open parent run</button>
				{/if}
				<details class="diagnostics">
					<summary>Identifiers</summary>
					<dl>
						<dt>Run</dt><dd><code>{selectedRunId}</code></dd>
						{#if run}<dt>Definition</dt><dd><code>{run.definitionDigest}</code></dd>{/if}
						{#if inspection}<dt>Snapshot sequence</dt><dd><code>{inspection.cursor.sequence}</code></dd>{/if}
					</dl>
				</details>
			</header>

			{#if detailError}<div class="notice notice-error" role="alert"><AlertTriangle size={15} /><span>{detailError}</span></div>{/if}
			{#if run?.error}<div class="notice notice-error" role="status"><AlertTriangle size={15} /><span><strong>{run.error.code}</strong> {run.error.message}</span></div>{/if}

			{#if inspection}
				{#if blockers.length > 0}
					<section class="blockers" aria-label="What holds this run">
						<h3><ShieldAlert size={15} /> Waiting on</h3>
						<ul>
							{#each blockers as blocker (blocker.kind + blocker.id)}
								<li data-kind={blocker.kind}>
									<span class="blocker-kind">{blocker.kind}</span>
									<span class="blocker-reason">{blocker.reason}{#if blocker.nodeInstanceId}<small>{blocker.nodeInstanceId}</small>{/if}</span>
									{#if blocker.kind === "approval" || blocker.kind === "release"}
										<button class="button-secondary" onclick={onOpenInbox}>{blocker.kind === "approval" ? "Decide in inbox" : "Reconcile in inbox"}</button>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				<div class="cards">
					<section class="card costs" aria-labelledby="costs-title">
						<h3 id="costs-title"><CircleDollarSign size={15} /> Cost</h3>
						<dl class="figures">
							<div><dt>Known</dt><dd>{formatMicros(inspection.costs.knownCostMicros)}</dd></div>
							<div><dt>Unknown</dt><dd class:warn={inspection.costs.unknownCostMicros !== "0"}>{formatMicros(inspection.costs.unknownCostMicros)}</dd></div>
							<div><dt>Limit</dt><dd>{formatMicros(inspection.costs.limitMicros)}</dd></div>
							<div><dt>Allocated</dt><dd>{formatMicros(inspection.costs.allocatedMicros)}</dd></div>
						</dl>
						<p class="card-note">
							{#if inspection.costs.uncertain}Some provider usage is not settled yet.{:else}All reported usage is settled.{/if}
							{#if inspection.costs.admissionBlocked} New work is held by the budget.{/if}
						</p>
					</section>

					<section class="card" aria-labelledby="acceptance-title">
						<h3 id="acceptance-title"><FileCheck2 size={15} /> Acceptance</h3>
						{#if inspection.acceptance.length === 0}<p class="empty-copy">No acceptance decision yet.</p>{/if}
						{#each inspection.acceptance as decision (decision.commandId)}
							<div class="decision" data-decision={decision.decision}>
								<span class="chip" data-status={decision.decision === "accepted" ? "succeeded" : "failed"}>{decision.decision}</span>
								<code title={decision.candidateDigest}>{shortDigest(decision.candidateDigest)}</code>
							</div>
						{/each}
						{#if rejected.length > 0}
							<table class="reasons">
								<caption>Why candidates were rejected</caption>
								<colgroup><col class="claim" /><col class="validator" /><col class="verdict" /><col class="reason" /></colgroup>
								<thead><tr><th scope="col">Claim</th><th scope="col">Validator</th><th scope="col">Verdict</th><th scope="col">Reason</th></tr></thead>
								<tbody>
									{#each rejected as decision (decision.commandId)}
										{#each decision.reasons as reason (reason.claimId + reason.validatorId)}
											<tr><td title={reason.claimId}>{reason.claimId}</td><td title={reason.validatorId}>{reason.validatorId}</td><td>{reason.verdict}</td><td title={reason.reasonCode}><code>{reason.reasonCode}</code></td></tr>
										{/each}
										{#each decision.groupFailures as group (group.groupId)}
											<tr><td title={group.groupId}>{group.groupId}</td><td>group</td><td>{group.passes} of {group.minimumPasses}</td><td title="MINIMUM_PASSES"><code>MINIMUM_PASSES</code></td></tr>
										{/each}
									{/each}
								</tbody>
							</table>
						{/if}
					</section>

					<section class="card" aria-labelledby="releases-title">
						<h3 id="releases-title"><Rocket size={15} /> Releases</h3>
						{#if inspection.releases.length === 0}<p class="empty-copy">No release requested.</p>{/if}
						<ul class="rows">
							{#each inspection.releases as release (release.operationId)}
								<li>
									<span class="chip" data-status={release.state === "succeeded" ? "succeeded" : release.state === "failed" ? "failed" : release.state === "uncertain" ? "uncertain" : "waiting"}>{release.state}</span>
									<span class="row-copy"><strong>{release.action}</strong><small>{release.nodeInstanceId} · generation {release.dispatchGeneration}{release.outcomeCode ? ` · ${release.outcomeCode}` : ""}</small></span>
									{#if release.state === "uncertain"}<button class="button-secondary" onclick={onOpenInbox}>Reconcile</button>{/if}
								</li>
							{/each}
						</ul>
					</section>

					<section class="card" aria-labelledby="children-title">
						<h3 id="children-title"><GitMerge size={15} /> Nested runs <span class="count">{children.length}</span></h3>
						{#if children.length === 0}<p class="empty-copy">This run started no nested runs.</p>{/if}
						<ul class="rows">
							{#each children as child (child.runId)}
								<li>
									<span class="chip" data-status={child.status ?? "queued"}>{child.status ?? child.state}</span>
									<span class="row-copy"><strong title={child.factoryId}>{child.factoryId}</strong><small title={child.runId}>{child.factoryVersion} · {child.runId}</small></span>
									<button class="button-secondary" onclick={() => open(child.runId, "child")}>Open</button>
								</li>
							{/each}
						</ul>
						{#if childrenCursor}<button class="more" onclick={() => more("children")}>Load more nested runs</button>{/if}
					</section>
				</div>

				<section class="card wide" aria-labelledby="attempts-title">
					<div class="card-head">
						<h3 id="attempts-title"><Boxes size={15} /> Attempts <span class="count">{attempts.length}{attemptsCursor ? "+" : ""}</span></h3>
						<form class="search" role="search" onsubmit={event => { event.preventDefault(); void filterAttempts(); }}>
							<input bind:value={attemptSearch} placeholder="Filter by node" aria-label="Filter attempts by node" />
							<button class="icon-button" aria-label="Apply attempt filter" type="submit"><Search size={14} /></button>
						</form>
					</div>
					{#if attempts.length === 0}<p class="empty-copy">{appliedSearch ? `No attempt matches “${appliedSearch}”.` : "No attempt has started."}</p>
					{:else}
						<div class="table-scroll">
							<table class="attempts">
								<thead><tr><th scope="col">Node</th><th scope="col">Attempt</th><th scope="col">Generation</th><th scope="col">Status</th><th scope="col">Result</th></tr></thead>
								<tbody>
									{#each attempts as attempt (attempt.attemptId)}
										<tr>
											<td><strong title={attempt.nodeInstanceId}>{attempt.nodeInstanceId}</strong></td>
											<td>{attempt.attemptNumber}</td>
											<td>{attempt.candidateGeneration}</td>
											<td><span class="chip" data-status={attempt.status === "completed" ? "succeeded" : attempt.status === "failed" || attempt.status === "stopped" ? "failed" : "running"}>{attempt.status}</span></td>
											<td>{#if attempt.resultDigest}<code title={attempt.resultDigest}>{shortDigest(attempt.resultDigest)}</code>{:else}<span class="muted">—</span>{/if}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
					{#if attemptsCursor}<button class="more" onclick={() => more("attempts")}>Load more attempts</button>{/if}
				</section>

				<section class="card wide" aria-labelledby="artifacts-title">
					<h3 id="artifacts-title"><FileCheck2 size={15} /> Artifacts and evidence <span class="count">{artifacts.length}{artifactsCursor ? "+" : ""}</span></h3>
					{#if artifacts.length === 0}<p class="empty-copy">No artifact has been staged.</p>{/if}
					<ul class="rows">
						{#each artifacts as artifact (artifact.artifactId)}
							<li>
								<span class="kind">{artifact.kind.replaceAll("_", " ")}</span>
								<span class="row-copy"><strong title={artifact.artifactId}>{artifact.nodeInstanceId ?? artifact.artifactId}</strong><small><code title={artifact.digest}>{shortDigest(artifact.digest)}</code> · {formatBytes(artifact.encodedBytes)}</small></span>
								<span class="row-actions">
									<button class="icon-button" aria-label={`Preview ${artifact.artifactId}`} title="Preview safely" onclick={() => { previewing = artifact; }}><Eye size={14} /></button>
									<button class="icon-button" aria-label={`Download ${artifact.artifactId}`} title="Download" onclick={() => download(artifact)}><Download size={14} /></button>
								</span>
							</li>
						{/each}
					</ul>
					{#if artifactsCursor}<button class="more" onclick={() => more("artifacts")}>Load more artifacts</button>{/if}
				</section>

				<section class="card wide" aria-labelledby="events-title">
					<h3 id="events-title"><Radio size={15} /> Recent events</h3>
					{#if events.length === 0}<p class="empty-copy">No new event since the snapshot at sequence {inspection.cursor.sequence}.</p>{/if}
					<ol class="events">
						{#each events as event (event.sequence)}
							<li><code>#{event.sequence}</code><span>{shortDigest(event.eventId)}</span><small>{formatBytes(event.payloadBytes)}{event.payload === undefined ? " · summarised" : ""}</small></li>
						{/each}
					</ol>
				</section>

				{#if controllable && run}
					<div class="controls-slot"><FactoryRunControls {projectId} runId={run.runId} {api} /></div>
				{/if}
			{:else if !detailError}
				<p class="empty-copy loading" aria-live="polite">Taking a snapshot…</p>
			{/if}
		{/if}
	</div>
</section>

{#if previewing && selectedRunId}
	<FactoryArtifactPreview {projectId} runId={selectedRunId} artifact={previewing} {api} onClose={() => { previewing = null; }} />
{/if}

<style>
	.run-inspector { display: grid; min-height: calc(100vh - 188px); grid-template-columns: 272px minmax(0, 1fr); background: var(--color-surface); color: var(--color-text-primary); }
	.run-list { min-width: 0; border-right: 1px solid var(--color-border); background: var(--color-surface-secondary); }
	.panel-heading { display: flex; height: 54px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-border); padding: 0 14px; }
	.panel-heading div { display: flex; align-items: center; gap: 8px; }
	.panel-heading h2 { margin: 0; font-size: 14px; }
	.panel-index { font-family: var(--font-mono); font-size: 10px; color: var(--color-accent); }
	.eyebrow { margin: 0; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--color-accent); }
	.filter { display: grid; gap: 4px; padding: 12px; color: var(--color-text-muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
	select, input { box-sizing: border-box; min-height: 34px; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); padding: 6px 9px; color: var(--color-text-primary); font: inherit; font-size: 12px; letter-spacing: normal; text-transform: none; }
	select:focus, input:focus, button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	button { font: inherit; }
	.runs { max-height: calc(100vh - 330px); overflow: auto; margin: 0; border-top: 1px solid var(--color-border); padding: 0; list-style: none; }
	.run-row { display: grid; width: 100%; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; border: 0; border-bottom: 1px solid var(--color-border); background: transparent; padding: 11px 12px; color: inherit; text-align: left; cursor: pointer; }
	.run-row:hover, .run-row.active { background: var(--color-surface-elevated); }
	.run-row.active { box-shadow: inset 3px 0 var(--color-accent); }
	.run-copy, .row-copy { display: grid; min-width: 0; }
	.run-copy strong, .row-copy strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
	.run-copy small, .row-copy small { overflow: hidden; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
	.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-text-muted); }
	.status-dot[data-status="running"], .status-dot[data-status="waiting"] { background: var(--color-accent); }
	.status-dot[data-status="succeeded"] { background: var(--color-green-500); }
	.status-dot[data-status="failed"], .status-dot[data-status="cancelled"] { background: var(--color-red-500); }
	.status-dot[data-status="uncertain"], .status-dot[data-status="cancelling"] { background: var(--color-amber-500); }
	.chip { justify-self: start; border-radius: 999px; padding: 2px 8px; background: color-mix(in srgb, var(--color-text-muted) 14%, transparent); color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
	.chip[data-status="running"], .chip[data-status="waiting"], .chip[data-status="queued"] { background: color-mix(in srgb, var(--color-accent) 15%, transparent); color: var(--color-accent); }
	.chip[data-status="succeeded"] { background: color-mix(in srgb, var(--color-green-500) 16%, transparent); color: var(--color-green-700); }
	.chip[data-status="failed"], .chip[data-status="cancelled"] { background: color-mix(in srgb, var(--color-red-500) 14%, transparent); color: var(--color-red-600); }
	.chip[data-status="uncertain"], .chip[data-status="cancelling"] { background: color-mix(in srgb, var(--color-amber-500) 18%, transparent); color: var(--color-amber-500); }
	.more { display: block; width: calc(100% - 24px); margin: 10px 12px; border: 1px dashed var(--color-border-strong); border-radius: 3px; background: transparent; padding: 8px; color: var(--color-text-secondary); font-size: 11px; font-weight: 700; cursor: pointer; }
	.more:hover { border-color: var(--color-accent); color: var(--color-accent); }
	.icon-button { display: inline-grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); color: var(--color-text-secondary); cursor: pointer; }
	.icon-button:hover { border-color: var(--color-accent); color: var(--color-accent); }
	.icon-button:disabled { cursor: not-allowed; opacity: .45; }
	.button-secondary { display: inline-flex; min-height: 30px; align-items: center; gap: 6px; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); padding: 5px 10px; color: var(--color-text-secondary); font-size: 11px; font-weight: 700; white-space: nowrap; cursor: pointer; }
	.button-secondary:hover { border-color: var(--color-accent); color: var(--color-accent); }
	.link-button { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; padding: 0; color: var(--color-accent); font-size: 12px; font-weight: 700; cursor: pointer; }
	.empty-copy { margin: 0; padding: 14px; color: var(--color-text-muted); font-size: 12px; line-height: 1.45; list-style: none; }
	.inline-error { margin: 0 12px 10px; color: var(--color-red-600); font-size: 12px; }
	.run-detail { min-width: 0; padding: 0 0 28px; }
	.detail-empty { display: grid; min-height: 520px; place-content: center; justify-items: start; padding: 40px; }
	.detail-empty h2 { max-width: 540px; margin: 8px 0; font-size: clamp(24px, 3vw, 36px); letter-spacing: -.03em; }
	.detail-empty > p:last-child { max-width: 520px; margin: 0; color: var(--color-text-secondary); }
	.empty-mark { display: grid; width: 52px; height: 52px; margin-bottom: 22px; place-items: center; border: 1px solid var(--color-border-strong); background: var(--color-surface-secondary); color: var(--color-accent); transform: rotate(-3deg); }
	.detail-heading { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; border-bottom: 1px solid var(--color-border); padding: 16px 20px; }
	.trail { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--color-text-muted); font-size: 11px; }
	.trail button { border: 0; background: transparent; padding: 0; color: var(--color-accent); font-size: 11px; font-weight: 700; cursor: pointer; }
	.trail-current { color: var(--color-text-secondary); font-weight: 700; }
	.heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
	.heading-copy { min-width: 0; }
	.heading-copy h2 { overflow: hidden; margin: 2px 0; font-size: 20px; text-overflow: ellipsis; white-space: nowrap; }
	.meta { margin: 0; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 10px; }
	.stream-badge { display: flex; flex: 0 1 auto; min-width: 0; max-width: 360px; align-items: center; gap: 9px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-surface-secondary); padding: 7px 10px; }
	.stream-badge span:last-child { display: grid; min-width: 0; }
	.stream-badge strong { font-size: 12px; }
	.stream-badge small { overflow: hidden; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
	.pulse { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--color-text-muted); }
	.stream-badge[data-state="live"] .pulse { background: var(--color-green-500); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-green-500) 18%, transparent); animation: pulse 1.8s ease-in-out infinite; }
	.stream-badge[data-state="lagging"] .pulse, .stream-badge[data-state="catching-up"] .pulse, .stream-badge[data-state="reconnecting"] .pulse, .stream-badge[data-state="connecting"] .pulse { background: var(--color-amber-500); }
	.stream-badge[data-state="offline"], .stream-badge[data-state="revoked"] { border-color: color-mix(in srgb, var(--color-red-500) 45%, var(--color-border)); }
	.stream-badge[data-state="offline"] .pulse, .stream-badge[data-state="revoked"] .pulse { background: var(--color-red-500); }
	@keyframes pulse { 50% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--color-green-500) 0%, transparent); } }
	.diagnostics summary { width: max-content; color: var(--color-text-muted); font-size: 11px; cursor: pointer; }
	.diagnostics dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 8px 0 0; font-size: 11px; }
	.diagnostics dt { color: var(--color-text-muted); }
	.diagnostics dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
	code { font-family: var(--font-mono); font-size: 10px; }
	.notice { display: flex; align-items: center; gap: 8px; margin: 12px 20px 0; border: 1px solid; border-radius: 3px; padding: 9px 12px; font-size: 12px; }
	.notice span { min-width: 0; overflow-wrap: anywhere; }
	.notice-error { border-color: var(--color-red-500); background: color-mix(in srgb, var(--color-red-500) 10%, var(--color-surface)); color: var(--color-red-700); }
	.blockers { margin: 16px 20px 0; border: 1px solid color-mix(in srgb, var(--color-amber-500) 55%, var(--color-border)); border-left-width: 4px; border-radius: 3px; background: color-mix(in srgb, var(--color-amber-400) 9%, var(--color-surface)); padding: 12px 14px; }
	.blockers h3, .card h3 { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
	.blockers ul { display: grid; gap: 8px; margin: 10px 0 0; padding: 0; list-style: none; }
	.blockers li { display: grid; grid-template-columns: 76px minmax(0, 1fr) auto; align-items: center; gap: 10px; font-size: 12px; }
	.blocker-kind { font-family: var(--font-mono); font-size: 10px; font-weight: 700; color: var(--color-amber-500); text-transform: uppercase; }
	.blocker-reason { min-width: 0; overflow-wrap: anywhere; }
	.blocker-reason small { margin-left: 8px; color: var(--color-text-muted); font-family: var(--font-mono); }
	.blocker-reason small::before { content: "· "; }
	.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 16px 20px 0; }
	.card { min-width: 0; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-surface-secondary); padding: 13px 14px; }
	.card.wide { margin: 14px 20px 0; }
	.card .empty-copy { padding: 10px 0 0; }
	.card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
	.count { border-radius: 999px; padding: 1px 7px; background: color-mix(in srgb, var(--color-accent) 12%, transparent); color: var(--color-accent); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0; }
	.figures { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 12px 0 0; }
	.figures div { min-width: 0; }
	.figures dt { color: var(--color-text-muted); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
	.figures dd { margin: 2px 0 0; overflow: hidden; font-family: var(--font-mono); font-size: 15px; font-weight: 700; text-overflow: ellipsis; }
	.figures dd.warn { color: var(--color-amber-500); }
	.card-note { margin: 10px 0 0; color: var(--color-text-secondary); font-size: 11px; }
	.decision { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
	.reasons, .attempts { width: 100%; margin-top: 10px; border-collapse: collapse; font-size: 11px; }
	.reasons caption { padding-bottom: 6px; color: var(--color-text-muted); font-size: 10px; text-align: left; text-transform: uppercase; letter-spacing: .06em; }
	.reasons th, .attempts th { border-bottom: 1px solid var(--color-border); padding: 5px 6px; color: var(--color-text-muted); font-size: 10px; font-weight: 700; text-align: left; }
	.reasons td, .attempts td { max-width: 220px; overflow: hidden; border-bottom: 1px solid var(--color-border); padding: 6px; text-overflow: ellipsis; white-space: nowrap; }
	.reasons { table-layout: fixed; }
	.reasons col.claim { width: 34%; }
	.reasons col.validator { width: 28%; }
	.reasons col.verdict { width: 14%; }
	.reasons col.reason { width: 24%; }
	.reasons td { max-width: none; }
	/* A large map pages in place: the table scrolls inside its card, so the page stays navigable. */
	.table-scroll { max-height: 440px; overflow: auto; border-bottom: 1px solid var(--color-border); }
	.attempts thead th { position: sticky; top: 0; z-index: 1; background: var(--color-surface-secondary); }
	.rows { display: grid; gap: 7px; margin: 10px 0 0; padding: 0; list-style: none; }
	.rows li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
	.kind { min-width: 98px; color: var(--color-accent); font-family: var(--font-mono); font-size: 9px; font-weight: 700; text-transform: uppercase; }
	.row-actions { display: flex; gap: 6px; }
	.search { display: flex; gap: 6px; }
	.search input { width: 210px; }
	.muted { color: var(--color-text-muted); }
	.events { display: grid; gap: 4px; margin: 10px 0 0; padding: 0; list-style: none; }
	.events li { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 10px; font-family: var(--font-mono); font-size: 10px; }
	.events small { color: var(--color-text-muted); }
	.controls-slot { margin: 14px 20px 0; border: 1px solid var(--color-border); border-radius: 3px; overflow: hidden; }
	.loading { padding: 20px; }
	@media (max-width: 900px) {
		.run-inspector { grid-template-columns: minmax(0, 1fr); }
		.run-list { border-right: 0; border-bottom: 1px solid var(--color-border); }
		.runs { display: flex; max-height: none; overflow-x: auto; }
		.runs li { flex: 0 0 240px; }
		.run-row { border-right: 1px solid var(--color-border); }
	}
	@media (max-width: 700px) {
		.detail-heading { padding: 14px; }
		.heading-row { flex-direction: column; align-items: stretch; }
		.heading-copy { max-width: 100%; }
		.stream-badge { max-width: 100%; }
		.cards, .card.wide, .blockers, .controls-slot, .notice { margin-left: 12px; margin-right: 12px; }
		.cards { grid-template-columns: minmax(0, 1fr); }
		.blockers li { grid-template-columns: 1fr; gap: 4px; }
		.search, .search input { width: 100%; }
		.kind { min-width: 0; }
		.rows li { grid-template-columns: minmax(0, 1fr) auto; }
		.rows li > .chip, .rows li > .kind { grid-column: 1 / -1; }
		.detail-empty { min-height: 360px; padding: 28px 16px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.stream-badge[data-state="live"] .pulse { animation: none; }
	}
</style>
