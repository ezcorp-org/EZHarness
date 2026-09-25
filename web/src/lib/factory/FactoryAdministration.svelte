<script lang="ts">
	import { AlertTriangle, CheckCircle2, History, KeyRound, Package, PackagePlus, RefreshCw, ShieldOff, Signature, Trash2, X } from "lucide-svelte";
	import type {
		FactoryAction,
		FactoryGrantResource,
		FactoryPackageAffectedAttempt,
		FactoryPackageImpact,
		FactoryPackageResource,
		FactoryPackageTransition,
		FactoryPrincipalKind,
		FactoryPurgePreview,
		FactoryPurgeRequestResource,
		FactoryRestoreResource,
	} from "@ezcorp/factory-sdk/types";
	import { FactoryApiClient, FactoryApiClientError, type FactoryAdministrationApi } from "./client";

	let {
		projectId,
		tenantId,
		administrator,
		api = new FactoryApiClient(),
	}: {
		projectId: string;
		tenantId: string | null;
		administrator: boolean;
		api?: FactoryAdministrationApi;
	} = $props();

	const ACTIONS: readonly FactoryAction[] = ["factory.author", "factory.publish", "factory.run", "factory.operate", "factory.approve", "factory.release", "factory.trust"];
	const TRANSITIONS: readonly FactoryPackageTransition[] = ["publish", "quarantine", "revoke"];

	/** What each transition means for this package now. The server still decides whether it is allowed. */
	/** A restore subject is canonical JSON when it names several identities (project, operation): shown as a path. */
	function subjectLabel(subjectId: string): string {
		try {
			const parts: unknown = JSON.parse(subjectId);
			if (Array.isArray(parts) && parts.length > 0 && parts.every(part => typeof part === "string")) return parts.join(" / ");
		} catch {
			// A plain identifier is shown as it is.
		}
		return subjectId;
	}

	/** A reference's name, told apart from another pin of the same package by its model and configuration. */
	function referenceLabel(reference: FactoryPackageResource["reference"]): string {
		const model = reference.model ? ` model ${reference.model}` : "";
		const configuration = reference.configurationDigest ? ` configuration ${reference.configurationDigest.slice(7, 19)}` : "";
		return `${reference.package}${model}${configuration}`;
	}

	function transitionLabel(item: Pick<FactoryPackageResource, "state">, transition: FactoryPackageTransition): string {
		if (transition === "quarantine") return "Quarantine";
		if (transition === "revoke") return "Revoke";
		return item.state === "quarantined" ? "Lift quarantine" : item.state === "active" ? "Re-trust" : "Trust";
	}

	let packages = $state<readonly FactoryPackageResource[]>([]);
	let grants = $state<readonly FactoryGrantResource[]>([]);
	let preview = $state<FactoryPurgePreview | null>(null);
	let purgeResult = $state<FactoryPurgeRequestResource | null>(null);
	let review = $state<{ readonly item: FactoryPackageResource; readonly transition: FactoryPackageTransition; readonly impact: FactoryPackageImpact } | null>(null);
	/** What the fence recorded for the last quarantine or revocation committed here. */
	let fenced = $state<{ readonly label: string; readonly revision: number; readonly items: readonly FactoryPackageAffectedAttempt[]; readonly more: boolean } | null>(null);
	let message = $state("");
	let errorMessage = $state("");
	let busy = $state(false);
	let installOpen = $state(false);
	let install = $state({ package: "", manifestName: "", version: "", digest: "", export: "", model: "", configurationDigest: "", installationId: "", releaseId: "" });
	let grantForm = $state({ principalKind: "user" as FactoryPrincipalKind, principalId: "", action: "factory.run" as FactoryAction, expires: "" });
	let purgeReason = $state("");
	let purgeConfirm = $state("");
	let restores = $state<readonly FactoryRestoreResource[]>([]);
	let requestVersion = 0;

	$effect(() => {
		const current = projectId;
		const version = ++requestVersion;
		message = "";
		errorMessage = "";
		review = null;
		fenced = null;
		if (current) void refresh(current, version);
	});

	function describe(error: unknown): string {
		if (error instanceof FactoryApiClientError) {
			if (error.status === 401 || error.status === 403) return "This needs a tenant administrator in an interactive session.";
			if (error.status === 412) return "Someone changed this first. The current state is loaded; review it and try again.";
			if (error.status === 409) return "That request conflicts with one already recorded.";
			return error.message;
		}
		return error instanceof Error ? error.message : "The factory service is unavailable.";
	}

	/** Each section loads on its own, so one refusal never blanks the others. */
	async function refresh(current = projectId, version = ++requestVersion): Promise<void> {
		const failures: string[] = [];
		const section = async <T>(read: () => Promise<T>, apply: (value: T) => void) => {
			try {
				const value = await read();
				if (version === requestVersion) apply(value);
			} catch (error) {
				failures.push(describe(error));
			}
		};
		await Promise.all([
			section(() => api.listPackages(current, { limit: 200 }), page => { packages = page.items; }),
			section(() => api.listGrants(current, { limit: 200 }), page => { grants = page.items; }),
			...(administrator && tenantId ? [
				section(() => api.purgePreview(tenantId), value => { preview = value; }),
				section(() => api.listRestores(tenantId), value => { restores = value; }),
			] : []),
		]);
		if (version === requestVersion && failures.length > 0) errorMessage = [...new Set(failures)].join(" ");
	}

	async function run(action: () => Promise<string>): Promise<void> {
		busy = true;
		errorMessage = "";
		message = "";
		try {
			message = await action();
			await refresh();
		} catch (error) {
			errorMessage = describe(error);
			if (error instanceof FactoryApiClientError && error.status === 412) await refresh();
		} finally {
			busy = false;
		}
	}

	async function openReview(item: FactoryPackageResource, transition: FactoryPackageTransition): Promise<void> {
		errorMessage = "";
		try {
			review = { item, transition, impact: await api.packageImpact(projectId, item.referenceId, transition) };
		} catch (error) {
			errorMessage = describe(error);
		}
	}

	function confirmReview(): Promise<void> {
		const current = review;
		if (!current) return Promise.resolve();
		review = null;
		fenced = null;
		return run(async () => {
			const updated = await api.transitionPackage(projectId, current.item.referenceId, current.transition, current.impact.currentRevision);
			const committed = `${current.item.reference.package} is ${updated.state ?? "bound"} at trust revision ${updated.revision}.`;
			if (current.transition === "publish") return `${committed} The change is in the audit log.`;
			// The fence stopped live work in the decision's own transaction; show exactly what it recorded.
			const record = await api.packageAffectedRuns(projectId, current.item.referenceId, { trustRevision: updated.revision, limit: 200 });
			fenced = { label: `${current.item.reference.package}@${current.item.reference.version}`, revision: updated.revision, items: record.items, more: record.nextCursor !== null };
			const runs = new Set(record.items.map(item => item.runId)).size;
			return `${committed} The fence reached ${runs}${fenced.more ? "+" : ""} run${runs === 1 ? "" : "s"}. The change is in the audit log.`;
		});
	}

	const DISPOSITIONS: Readonly<Record<FactoryPackageAffectedAttempt["disposition"], string>> = {
		"cancel-requested": "cancel requested",
		"already-cancelling": "already cancelling",
		"run-terminal": "already finished",
	};

	function submitInstall(): Promise<void> {
		const model = install.model.trim(), configurationDigest = install.configurationDigest.trim();
		const reference = {
			package: install.package.trim(), manifestName: install.manifestName.trim(), version: install.version.trim(), digest: install.digest.trim(), export: install.export.trim(),
			...(model ? { model } : {}), ...(configurationDigest ? { configurationDigest } : {}),
		};
		return run(async () => {
			const bound = await api.installPackage(projectId, { reference, installationId: install.installationId.trim(), releaseId: install.releaseId.trim() });
			installOpen = false;
			return `${bound.reference.package}@${bound.reference.version} is bound. Trust it before any run can dispatch it.`;
		});
	}

	function submitGrant(): Promise<void> {
		const expiresAtMs = grantForm.expires ? Date.parse(grantForm.expires) : null;
		if (expiresAtMs !== null && !Number.isFinite(expiresAtMs)) { errorMessage = "The expiry is not a valid date."; return Promise.resolve(); }
		const existing = grants.find(item => item.principalKind === grantForm.principalKind && item.principalId === grantForm.principalId.trim() && item.action === grantForm.action);
		return run(async () => {
			const granted = await api.setGrant(projectId, grantForm.principalKind, grantForm.principalId.trim(), grantForm.action, existing?.revision ?? 0, expiresAtMs);
			return `${granted.action} granted to ${granted.principalKind} ${granted.principalId} at revision ${granted.revision}.`;
		});
	}

	function revokeGrant(item: FactoryGrantResource): Promise<void> {
		return run(async () => {
			const revoked = await api.revokeGrant(projectId, item.principalKind, item.principalId, item.action, item.revision);
			return `${revoked.action} revoked for ${revoked.principalKind} ${revoked.principalId}.`;
		});
	}

	function submitPurge(): Promise<void> {
		const tenant = tenantId;
		if (!tenant) return Promise.resolve();
		return run(async () => {
			purgeResult = await api.requestPurge(tenant, purgeReason.trim(), purgeConfirm.trim());
			return purgeResult.state === "queued"
				? `Purge request ${purgeResult.requestId} is queued. Nothing has been deleted.`
				: `Purge request ${purgeResult.requestId} was recorded and refused: open work remains.`;
		});
	}

	/** Signs the exact report digest the administrator was shown. */
	function signRestore(restore: FactoryRestoreResource): Promise<void> {
		const tenant = tenantId;
		const digest = restore.reportDigest;
		if (!tenant || !digest) return Promise.resolve();
		return run(async () => {
			const signed = await api.signRestore(tenant, restore.restoreId, digest);
			const blocked = signed.blockedRuns.length > 0 ? ` ${signed.blockedRuns.length} blocked run${signed.blockedRuns.length === 1 ? " stays" : "s stay"} at the old epoch.` : "";
			return `Restore ${signed.restoreId} is signed and service is open. ${signed.rebound} run${signed.rebound === 1 ? "" : "s"} moved to epoch ${restore.executionEpoch}.${blocked}`;
		});
	}

	function expiry(value: number | null): string {
		return value === null ? "no expiry" : `expires ${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
	}
</script>

<section class="administration" data-testid="factory-administration">
	{#if errorMessage}<div class="notice notice-error" role="alert"><AlertTriangle size={15} /><span>{errorMessage}</span><button aria-label="Dismiss error" onclick={() => { errorMessage = ""; }}><X size={14} /></button></div>{/if}
	{#if message}<div class="notice notice-ok" role="status"><CheckCircle2 size={15} /><span>{message}</span><button aria-label="Dismiss message" onclick={() => { message = ""; }}><X size={14} /></button></div>{/if}
	{#if !administrator}<p class="role-note">You can read packages and grants. Changing them needs a tenant administrator.</p>{/if}

	<div class="columns">
		<section class="panel" aria-labelledby="packages-title">
			<div class="panel-heading">
				<div><span class="panel-index">01</span><h2 id="packages-title">Runner packages</h2><span class="count">{packages.length}</span></div>
				<div class="heading-actions">
					<button class="icon-button" aria-label="Refresh administration" title="Refresh" onclick={() => refresh()}><RefreshCw size={15} /></button>
					<button class="button-secondary" disabled={!administrator} aria-expanded={installOpen} onclick={() => { installOpen = !installOpen; }}><PackagePlus size={14} /> Install</button>
				</div>
			</div>
			{#if installOpen}
				<form class="form-grid" aria-label="Install runner package" onsubmit={event => { event.preventDefault(); void submitInstall(); }}>
					<label>Package<input bind:value={install.package} placeholder="@ezcorp/reference-code" required /></label>
					<label>Manifest name<input bind:value={install.manifestName} placeholder="reference-code" required /></label>
					<label>Version<input bind:value={install.version} placeholder="1.0.0" required /></label>
					<label>Export<input bind:value={install.export} placeholder="run" required /></label>
					<label class="span">Digest<input bind:value={install.digest} placeholder="sha256:…" required /></label>
					<label>Model (optional)<input bind:value={install.model} /></label>
					<label>Configuration digest (optional)<input bind:value={install.configurationDigest} placeholder="sha256:…" /></label>
					<label>Installation<input bind:value={install.installationId} required /></label>
					<label>Release<input bind:value={install.releaseId} required /></label>
					<div class="span form-actions"><button class="button-primary" type="submit" disabled={busy}>Bind package</button></div>
				</form>
			{/if}
			{#if packages.length === 0}<p class="empty-copy">No runner package is bound to this project.</p>{/if}
			<ul class="rows">
				{#each packages as item (item.referenceId)}
					<li>
						<Package size={15} />
						<span class="row-copy">
							<strong title={item.reference.package}>{item.reference.package}@{item.reference.version}</strong>
							<small title={item.reference.digest}>{item.reference.export}{item.reference.model ? ` · model ${item.reference.model}` : ""} · {item.reference.digest.slice(0, 19)}…{item.reference.configurationDigest ? ` · configuration ${item.reference.configurationDigest.slice(0, 19)}…` : ""} · trust revision {item.revision}</small>
						</span>
						<span class="chip" data-state={item.state ?? "none"}>{item.state ?? "untrusted"}</span>
						{#if item.state === "revoked"}
							<small class="terminal-note">Revoked for good. A replacement needs a new pinned reference.</small>
						{:else}
							<span class="row-actions" role="group" aria-label={`Trust actions for ${referenceLabel(item.reference)}`}>
								{#each TRANSITIONS as transition (transition)}
									<button class="button-secondary" disabled={!administrator || busy} onclick={() => openReview(item, transition)}>{transitionLabel(item, transition)}</button>
								{/each}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			{#if fenced}
				<section class="fence-record" aria-label="Fence record">
					<h3>Fence record · {fenced.label} · trust revision {fenced.revision}</h3>
					{#if fenced.items.length === 0}
						<p class="empty-copy">No live attempt used this package, so the fence stopped nothing.</p>
					{:else}
						<ul class="rows">
							{#each fenced.items as item (item.attemptId)}
								<li><ShieldOff size={14} /><span class="row-copy"><strong title={item.runId}>{item.runId}</strong><small>attempt {item.attemptId} · was {item.attemptStatus} · {item.launchState ?? "not launched"}</small></span><span class="chip" data-state={item.state}>{DISPOSITIONS[item.disposition]}</span></li>
							{/each}
						</ul>
						{#if fenced.more}<p class="empty-copy">Only the first {fenced.items.length} attempts are shown.</p>{/if}
					{/if}
				</section>
			{/if}
		</section>

		<section class="panel" aria-labelledby="grants-title">
			<div class="panel-heading">
				<div><span class="panel-index">02</span><h2 id="grants-title">Project grants</h2><span class="count">{grants.filter(item => !item.revoked).length}</span></div>
			</div>
			<form class="form-grid" aria-label="Grant factory authority" onsubmit={event => { event.preventDefault(); void submitGrant(); }}>
				<label>Principal<select bind:value={grantForm.principalKind}><option value="user">user</option><option value="service">service</option></select></label>
				<label>Identifier<input bind:value={grantForm.principalId} required placeholder="member id" /></label>
				<label>Action<select bind:value={grantForm.action}>{#each ACTIONS as action (action)}<option value={action}>{action}</option>{/each}</select></label>
				<label>Expires (optional)<input type="datetime-local" bind:value={grantForm.expires} /></label>
				<div class="span form-actions"><button class="button-primary" type="submit" disabled={!administrator || busy}><KeyRound size={14} /> Grant</button></div>
			</form>
			{#if grants.length === 0}<p class="empty-copy">No grant is recorded for this project.</p>{/if}
			<ul class="rows">
				{#each grants as item (item.principalKind + item.principalId + item.action)}
					<li class="grant" class:revoked={item.revoked}>
						<KeyRound size={14} />
						<span class="row-copy"><strong title={item.displayName}>{item.displayName}</strong><small title={item.principalId}>{item.principalKind} · {item.principalId}</small><small>{item.action} · revision {item.revision} · {item.revoked ? "revoked" : expiry(item.expiresAtMs)}</small></span>
						{#if !item.revoked}<button class="icon-button" aria-label={`Revoke ${item.action} for ${item.principalId}`} title="Revoke" disabled={!administrator || busy} onclick={() => revokeGrant(item)}><ShieldOff size={14} /></button>{/if}
					</li>
				{/each}
			</ul>
		</section>
	</div>

	<section class="panel purge" aria-labelledby="purge-title">
		<div class="panel-heading">
			<div><span class="panel-index">03</span><h2 id="purge-title">Tenant purge request</h2></div>
		</div>
		{#if !administrator}
			<p class="empty-copy">Only a tenant administrator can ask for a purge.</p>
		{:else if !tenantId}
			<p class="empty-copy">Factory services are not ready, so the tenant is not known yet.</p>
		{:else}
			<p class="purge-copy">A request is recorded in the audit log and deletes nothing. It is refused while any work below is still open. The destructive purge is carried out and certified separately.</p>
			{#if preview}
				<table class="preconditions">
					<caption>Closing conditions for tenant <code>{preview.tenantId}</code></caption>
					<thead><tr><th scope="col">Condition</th><th scope="col">Open</th><th scope="col">State</th></tr></thead>
					<tbody>
						{#each preview.preconditions as condition (condition.id)}
							<tr data-satisfied={condition.satisfied}><td>{condition.detail}</td><td>{condition.count}</td><td>{condition.satisfied ? "Closed" : "Open"}</td></tr>
						{/each}
					</tbody>
				</table>
				<p class="audit-loss"><Trash2 size={14} /><span>A purge would remove <strong>{preview.auditRowsLost}</strong> audit record{preview.auditRowsLost === 1 ? "" : "s"}. The request itself is kept.</span></p>
			{/if}
			<form class="form-grid" aria-label="Request tenant purge" onsubmit={event => { event.preventDefault(); void submitPurge(); }}>
				<label class="span">Reason<textarea bind:value={purgeReason} rows="2" required></textarea></label>
				<label class="span">Type the tenant identifier to confirm<input bind:value={purgeConfirm} required autocomplete="off" placeholder={tenantId} /></label>
				<div class="span form-actions"><button class="button-danger" type="submit" disabled={busy || purgeConfirm.trim() !== tenantId || !purgeReason.trim()}>Record purge request</button></div>
			</form>
			{#if purgeResult}<p class="purge-result" data-state={purgeResult.state} role="status">Request <code>{purgeResult.requestId}</code> · {purgeResult.state}</p>{/if}
		{/if}
	</section>

	{#if administrator && tenantId}
		<section class="panel restores" aria-labelledby="restore-title">
			<div class="panel-heading">
				<div><span class="panel-index">04</span><h2 id="restore-title">Restore signatures</h2><span class="count">{restores.length}</span></div>
			</div>
			<p class="purge-copy">A restore keeps service closed until a tenant administrator signs its recovery report. The signature names the report digest; the server checks it against the report it holds.</p>
			{#if restores.length === 0}<p class="empty-copy">No restore has been opened for this tenant.</p>{/if}
			{#each restores as restore (restore.restoreId)}
				<article class="restore" data-state={restore.state} aria-labelledby={`restore-${restore.restoreId}`}>
					<header>
						<History size={15} />
						<h3 id={`restore-${restore.restoreId}`}>{restore.restoreId}</h3>
						<span class="chip" data-state={restore.state === "enabled" ? "active" : restore.report && restore.report.blockedChecks.length > 0 ? "revoked" : "quarantined"}>{restore.state.replace("_", " ")}</span>
					</header>
					<dl class="restore-facts">
						<div><dt>Mode</dt><dd>{restore.mode}</dd></div>
						<div><dt>Checkpoint</dt><dd>{restore.checkpointId}</dd></div>
						<div><dt>Epoch</dt><dd>{restore.previousEpoch} → {restore.executionEpoch}</dd></div>
						{#if restore.reportDigest}<div class="wide"><dt>Report digest</dt><dd><code title={restore.reportDigest}>{restore.reportDigest}</code></dd></div>{/if}
						{#if restore.signedBy}<div class="wide"><dt>Signed</dt><dd>by {restore.signedBy}{restore.signedAtMs ? ` · ${new Date(restore.signedAtMs).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}</dd></div>{/if}
					</dl>
					{#if restore.report}
						{@const report = restore.report}
						<table class="preconditions findings">
							<caption>Findings{report.findingCount > report.findings.length ? `, ${report.findings.length} of ${report.findingCount} with every blocked one first` : ""}</caption>
							<thead><tr><th scope="col">Subject</th><th scope="col">Result</th><th scope="col">Reason</th></tr></thead>
							<tbody>
								{#each report.findings as finding (finding.findingId)}
									<tr data-disposition={finding.disposition}><td><span class="subject-kind">{finding.subjectKind}</span> <code>{subjectLabel(finding.subjectId)}</code></td><td>{finding.disposition}</td><td>{finding.reason}</td></tr>
								{/each}
							</tbody>
						</table>
						<p class="audit-loss"><span>Releases recovered <strong>{report.releaseIdentities.recovered}</strong> of {report.releaseIdentities.archived}. Blocked runs <strong>{report.blockedRuns.length}</strong>. Recovery took {Math.round(report.recoveryMs / 1000)} s.</span></p>
					{/if}
					{#if restore.state === "awaiting_signature"}
						<div class="form-actions restore-actions">
							{#if restore.report && restore.report.blockedChecks.length > 0}
								<p class="refusal">A blocked check keeps the tenant closed, so this report cannot be signed: {restore.report.blockedChecks.join("; ")}.</p>
							{:else}
								<button class="button-primary" disabled={busy || !restore.reportDigest} onclick={() => signRestore(restore)}><Signature size={14} /> Sign report and reopen service</button>
							{/if}
						</div>
					{/if}
				</article>
			{/each}
		</section>
	{/if}
</section>

{#if review}
	<div class="modal-backdrop" role="presentation" onclick={event => event.target === event.currentTarget && (review = null)}>
		<div class="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title">
			<header>
				<div><p class="eyebrow">Review before committing</p><h2 id="review-title">{transitionLabel(review.item, review.transition)} {review.item.reference.package}</h2></div>
				<button class="icon-button" aria-label="Close review" onclick={() => { review = null; }}><X size={16} /></button>
			</header>
			<div class="review-body">
				{#if review.impact.allowed}
					<p>{review.impact.runs.length === 0 ? "No live run uses this package." : `${review.impact.runs.length}${review.impact.truncated ? "+" : ""} live run${review.impact.runs.length === 1 ? "" : "s"} use this package.`}{review.transition === "publish" ? "" : " New dispatch stops at once."}</p>
					{#if review.impact.runs.length > 0}
						<ul class="rows">
							{#each review.impact.runs as affected (affected.runId)}
								<li><span class="chip" data-state="affected">{affected.status}</span><span class="row-copy"><strong>{affected.factoryId}</strong><small>{affected.runId}</small></span><small>{affected.liveAttempts} live attempt{affected.liveAttempts === 1 ? "" : "s"}</small></li>
							{/each}
						</ul>
					{/if}
				{:else}
					<p class="refusal" role="alert">{review.impact.refusal}</p>
				{/if}
			</div>
			<footer>
				<button class="button-secondary" onclick={() => { review = null; }}>Cancel</button>
				<button class={review.transition === "publish" ? "button-primary" : "button-danger"} disabled={!review.impact.allowed || busy} onclick={confirmReview}>Commit at revision {review.impact.currentRevision}</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.administration { min-height: calc(100vh - 188px); background: var(--color-surface); padding: 18px 20px 28px; color: var(--color-text-primary); }
	.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); align-items: start; gap: 16px; }
	.panel { min-width: 0; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-surface-secondary); }
	.purge, .restores { margin-top: 16px; }
	.restore { border-top: 1px solid var(--color-border); padding: 12px 14px; }
	/* A long restore id keeps its line; the state chip moves below it rather than squeezing it. */
	.restore header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
	.restore h3 { min-width: 0; flex: 1 1 14rem; margin: 0; font-size: 13px; overflow-wrap: anywhere; }
	.fence-record { border-top: 1px solid var(--color-border); }
	.fence-record h3 { margin: 0; padding: 12px 14px 4px; font-size: 13px; overflow-wrap: anywhere; }
	.restore-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; margin: 10px 0 0; font-size: 12px; }
	.restore-facts .wide { grid-column: 1 / -1; }
	.restore-facts dt { color: var(--color-text-muted); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
	.restore-facts dd { margin: 2px 0 0; overflow-wrap: anywhere; }
	.restore-facts code { overflow-wrap: anywhere; white-space: normal; }
	.preconditions.findings { width: 100%; margin: 12px 0 0; table-layout: fixed; }
	/* A finding is read in full: subjects and reasons wrap, and only the disposition keeps one line. */
	.preconditions.findings td { overflow-wrap: break-word; vertical-align: top; }
	.preconditions.findings code { font-size: 11px; overflow-wrap: anywhere; }
	.subject-kind { color: var(--color-text-muted); }
	.preconditions.findings :is(th, td):nth-child(1) { width: 38%; }
	.preconditions.findings :is(th, td):nth-child(2) { width: 84px; white-space: nowrap; }
	.findings tr[data-disposition="blocked"] td:nth-child(2) { color: var(--color-red-600); font-weight: 700; }
	.restore .audit-loss { margin: 10px 0 0; }
	.restore-actions { flex-direction: column; align-items: flex-end; gap: 6px; margin-top: 10px; }
	.restore-actions .refusal { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
	.panel-heading { display: flex; min-height: 52px; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--color-border); padding: 8px 14px; }
	.panel-heading > div { display: flex; align-items: center; gap: 8px; }
	.panel-heading h2 { margin: 0; font-size: 14px; }
	.panel-index { font-family: var(--font-mono); font-size: 10px; color: var(--color-accent); }
	.heading-actions { display: flex; gap: 6px; }
	.eyebrow { margin: 0; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--color-accent); }
	.count { border-radius: 999px; padding: 1px 7px; background: color-mix(in srgb, var(--color-accent) 12%, transparent); color: var(--color-accent); font-family: var(--font-mono); font-size: 10px; }
	.role-note { margin: 0 0 14px; color: var(--color-text-secondary); font-size: 12px; }
	.notice { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; border: 1px solid; border-radius: 3px; padding: 9px 12px; font-size: 12px; }
	.notice span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
	.notice button { border: 0; background: transparent; color: inherit; cursor: pointer; }
	.notice-error { border-color: var(--color-red-500); background: color-mix(in srgb, var(--color-red-500) 10%, var(--color-surface)); color: var(--color-red-700); }
	.notice-ok { border-color: var(--color-green-500); background: color-mix(in srgb, var(--color-green-500) 9%, var(--color-surface)); color: var(--color-green-700); }
	.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; border-bottom: 1px solid var(--color-border); padding: 12px 14px; }
	.form-grid .span { grid-column: 1 / -1; }
	.form-actions { display: flex; justify-content: flex-end; }
	label { display: grid; min-width: 0; gap: 4px; color: var(--color-text-muted); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
	input, select, textarea { box-sizing: border-box; width: 100%; min-height: 34px; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); padding: 6px 9px; color: var(--color-text-primary); font: inherit; font-size: 12px; letter-spacing: normal; text-transform: none; }
	textarea { resize: vertical; }
	input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	button { font: inherit; }
	.rows { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
	.rows li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; border-bottom: 1px solid var(--color-border); padding: 10px 14px; }
	.panel .rows li:has(.row-actions) { grid-template-columns: auto minmax(0, 1fr) auto; }
	.rows li .row-actions, .rows li .terminal-note { grid-column: 2 / -1; }
	.terminal-note { color: var(--color-text-muted); font-size: 11px; }
	.rows li.revoked { opacity: .55; }
	.row-copy { display: grid; min-width: 0; }
	.row-copy strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
	.row-copy small { overflow: hidden; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
	.row-actions { display: flex; flex-wrap: wrap; gap: 6px; }
	.chip { border-radius: 999px; padding: 2px 8px; background: color-mix(in srgb, var(--color-text-muted) 14%, transparent); color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
	.chip[data-state="active"] { background: color-mix(in srgb, var(--color-green-500) 16%, transparent); color: var(--color-green-700); }
	.chip[data-state="quarantined"], .chip[data-state="affected"] { background: color-mix(in srgb, var(--color-amber-500) 18%, transparent); color: var(--color-amber-500); }
	.chip[data-state="revoked"] { background: color-mix(in srgb, var(--color-red-500) 14%, transparent); color: var(--color-red-600); }
	.icon-button { display: inline-grid; width: 32px; height: 32px; place-items: center; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); color: var(--color-text-secondary); cursor: pointer; }
	.button-primary, .button-secondary, .button-danger { display: inline-flex; min-height: 32px; align-items: center; justify-content: center; gap: 6px; border-radius: 3px; padding: 6px 11px; font-size: 11px; font-weight: 700; white-space: nowrap; cursor: pointer; }
	.button-primary { border: 1px solid var(--color-accent); background: var(--color-accent); color: white; }
	.button-secondary { border: 1px solid var(--color-border-strong); background: var(--color-surface-elevated); color: var(--color-text-secondary); }
	.button-danger { border: 1px solid var(--color-red-600); background: var(--color-red-600); color: white; }
	button:disabled { cursor: not-allowed; opacity: .45; }
	.empty-copy { margin: 0; padding: 14px; color: var(--color-text-muted); font-size: 12px; }
	.purge-copy { margin: 0; padding: 12px 14px 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; }
	.preconditions { width: calc(100% - 28px); margin: 12px 14px 0; border-collapse: collapse; font-size: 12px; }
	.preconditions caption { padding-bottom: 6px; color: var(--color-text-muted); font-size: 10px; text-align: left; text-transform: uppercase; letter-spacing: .06em; }
	/* An identifier is shown exactly as it must be typed below, never in capitals. */
	.preconditions caption code { text-transform: none; letter-spacing: 0; }
	.preconditions th { border-bottom: 1px solid var(--color-border); padding: 5px 6px; color: var(--color-text-muted); font-size: 10px; text-align: left; }
	.preconditions td { border-bottom: 1px solid var(--color-border); padding: 6px; }
	.preconditions tr[data-satisfied="false"] td:last-child { color: var(--color-amber-500); font-weight: 700; }
	.preconditions tr[data-satisfied="true"] td:last-child { color: var(--color-green-700); }
	.audit-loss { display: flex; align-items: center; gap: 6px; margin: 10px 14px 0; color: var(--color-text-secondary); font-size: 12px; }
	.purge .form-grid { border-bottom: 0; }
	.purge-result { margin: 0; padding: 0 14px 14px; font-size: 12px; }
	code { font-family: var(--font-mono); font-size: 10px; }
	.modal-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; overflow: auto; place-items: start center; background: rgb(4 8 18 / .72); padding: 8vh 16px; }
	.review-dialog { width: min(620px, 100%); border: 1px solid var(--color-border-strong); border-top: 4px solid var(--color-amber-500); border-radius: 4px; background: var(--color-surface); box-shadow: var(--shadow-2xl); }
	.review-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--color-border); padding: 14px 18px; }
	.review-dialog h2 { margin: 3px 0 0; font-size: 18px; overflow-wrap: anywhere; }
	.review-body { padding: 14px 18px; font-size: 13px; }
	.review-body > p { margin: 0 0 10px; }
	.review-body .rows li { padding: 8px 0; }
	.refusal { color: var(--color-red-600); font-weight: 700; }
	.review-dialog footer { display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--color-border); padding: 12px 18px; }
	@media (max-width: 700px) {
		.administration { padding: 12px; }
		.columns { grid-template-columns: 1fr; }
		.form-grid { grid-template-columns: 1fr; }
		.rows li { grid-template-columns: auto minmax(0, 1fr); }
		.rows li .chip { justify-self: start; grid-column: 2; }
		/* A grant's revoke button stays on its row; detail lines wrap rather than hide the action or revision. */
		.rows li.grant { grid-template-columns: auto minmax(0, 1fr) auto; }
		.row-copy small { white-space: normal; overflow-wrap: anywhere; }
		.review-dialog footer { flex-direction: column-reverse; align-items: stretch; }
		/* Narrow findings read as short cards: the subject on its own line, then the result and reason. */
		.preconditions.findings, .preconditions.findings tbody, .preconditions.findings tr { display: block; }
		.preconditions.findings thead { display: none; }
		.preconditions.findings tr { border-bottom: 1px solid var(--color-border); padding: 6px 0; }
		.preconditions.findings td { display: inline; border: 0; padding: 0 6px 0 0; }
		.preconditions.findings td:first-child { display: block; padding-bottom: 2px; }
		.preconditions.findings :is(th, td):nth-child(1), .preconditions.findings :is(th, td):nth-child(2) { width: auto; }
	}
</style>
