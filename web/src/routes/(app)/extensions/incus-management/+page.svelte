<script lang="ts">
	import { onMount } from "svelte";
	import IncusCapacityPanel from "$lib/components/IncusCapacityPanel.svelte";

	let { data } = $props<{ data: { operatorId: string } }>();

	type Environment = {
		installationId: string;
		releaseId: string;
		releaseGeneration: number;
		connectionId: string;
		connectionRevision: number;
		presetId: string;
		label: string;
		profile: string;
		qualified: boolean;
		qualificationState?: "qualified" | "running" | "failed" | "not_qualified";
		qualificationRunId?: string | null;
		qualificationValidUntil: string | null;
		blockedReason: string | null;
		limits?: { memoryBytes: number; cpuMillis: number; diskBytes: number; pids: number };
		active?: boolean;
		setupId?: string | null;
	};
	type Operation = {
		id: string;
		kind: string;
		state: string;
		errorCode?: string | null;
		createdAt?: string;
		updatedAt?: string;
	} | null;
	type Feature = {
		projectId: string;
		projectName: string;
		bindingId: string;
		installationId: string;
		releaseId: string;
		connectionId: string;
		connectionRevision?: number | null;
		generation?: number;
		presetId: string;
		desiredState: string;
		observedState: string;
		operation: Operation;
		retired?: boolean;
		tombstonedAt?: string | null;
		cleanupConfirmedAt?: string | null;
	};
	type Project = { id: string; name: string };
	type Snapshot = { environments: Environment[]; projects: Project[]; features: Feature[]; truncated?: boolean };
	type FixturePlan = { digest: string; scope?: Record<string, unknown>; directory?: string; config?: { cases?: Record<string, { projectId?: string; bindingId?: string; canaryPath?: string }> ; unqualifiedPresetId?: string }; profile?: string; connectionRevision?: number; providerGeneration?: number };
	type QualificationDraft = { environmentKey: string; operationId: string; planDigest: string; phase: "planned" | "ready" | "running" | "failed"; planSteps: number; scope: ReturnType<typeof scope>; startedAt?: number; applyUncertain?: boolean; applyAttempted?: boolean };
	type ProjectDraft = { name: string; environmentKey: string; prepareKey: string; operationKey: string; projectId?: string };

	let snapshot = $state<Snapshot>({ environments: [], projects: [], features: [] });
	let loading = $state(true);
	let busy = $state("");
	let errorMessage = $state("");
	let recoveryWarning = $state("");
	let notice = $state("");
	let selectedEnvironment = $state("");
	let projectName = $state("New sandbox project");
	let projectDraft = $state<ProjectDraft | null>(null);
	let qualifyEnvironment = $state("");
	let qualificationDraft = $state<QualificationDraft | null>(null);
	let mutationKeys = $state<Record<string, string>>({});
	let reviewedFixturePlan = $state(false);
	let fixturePlan = $state<FixturePlan | null>(null);
	let acknowledgedQualification = $state(false);
	let destroyBinding = $state("");
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	const eligibleEnvironments = $derived(snapshot.environments.filter(item => item.active !== false));
	const selected = $derived(eligibleEnvironments.find(item => environmentKey(item) === selectedEnvironment));
	const qualificationTarget = $derived(snapshot.environments.find(item => environmentKey(item) === qualifyEnvironment));
	const draftMatchesTarget = $derived(!!qualificationDraft && qualificationDraft.environmentKey === qualifyEnvironment);

	function environmentKey(item: Environment): string {
		return `${item.installationId}:${item.releaseId}:${item.releaseGeneration}:${item.connectionId}:${item.connectionRevision}:${item.presetId}`;
	}

	function scope(item: Environment) {
		return { installationId: item.installationId, releaseId: item.releaseId,
			connectionId: item.connectionId, presetId: item.presetId };
	}

	class HttpRequestError extends Error {
		readonly status: number;
		readonly payload: unknown;
		constructor(message: string, status: number, payload: unknown) {
			super(message);
			this.status = status;
			this.payload = payload;
		}
	}

	function messageFrom(body: unknown, fallback: string): string {
		if (body && typeof body === "object") {
			const value = body as Record<string, unknown>;
			if (typeof value.message === "string") return value.message;
			if (typeof value.error === "string") return value.error;
			if (typeof value.reason === "string") return value.reason;
		}
		return fallback;
	}

	async function request(url: string, body?: Record<string, unknown>) {
		const response = await fetch(url, body ? {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		} : { cache: "no-store" });
		const payload: unknown = await response.json().catch(() => null);
		if (!response.ok) throw new HttpRequestError(messageFrom(payload, `Request failed (${response.status})`), response.status, payload);
		return payload as Record<string, unknown>;
	}

	async function load({ quiet = false }: { quiet?: boolean } = {}) {
		if (!quiet) loading = true;
		try {
			const data = await request("/api/infrastructure/incus/management") as unknown as Snapshot;
			snapshot = { environments: data.environments ?? [], projects: data.projects ?? [], features: data.features ?? [], truncated: data.truncated };
			if (!selectedEnvironment && snapshot.environments.length) selectedEnvironment = environmentKey(snapshot.environments[0]!);
			syncQualificationDraft();
			if (projectDraft?.projectId && snapshot.features.some(feature => feature.projectId === projectDraft!.projectId
				&& feature.operation?.kind === "CREATE" && feature.operation.state === "SUCCEEDED"
				&& feature.observedState === "STOPPED")) setProjectDraft(null);
			settleMutationKeys();
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : "Could not load Incus environments";
		} finally {
			if (!quiet) loading = false;
		}
	}

	async function act(label: string, url: string, body: Record<string, unknown>, success?: string) {
		busy = label;
		errorMessage = "";
		notice = "";
		try {
			const result = await request(url, body);
			if (success) notice = success;
			if (label === "qualification") notice = "Qualification started. The service may restart while it checks this environment.";
			if (label === "create") notice = result.state === "QUEUED"
				? "Sandbox queued for capacity. Its status will update here."
				: "Sandbox creation was admitted. Its status will update here.";
			await load({ quiet: true });
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "The Incus request failed";
			await load({ quiet: true });
			errorMessage = message;
		} finally {
			busy = "";
		}
	}

	function draftStorageKey(): string { return userStorageKey("qualification-draft"); }

	function setQualificationDraft(value: QualificationDraft | null) {
		qualificationDraft = value;
		try {
			if (value) localStorage.setItem(draftStorageKey(), JSON.stringify(value));
			else localStorage.removeItem(draftStorageKey());
		} catch { /* The page can still finish if browser storage is unavailable. */ }
	}

	async function planQualification(target: Environment) {
		if (qualificationDraft) {
			errorMessage = "Finish or clean up the current qualification fixtures before preparing another environment.";
			return;
		}
		busy = "probe-plan";
		errorMessage = "";
		notice = "";
		qualifyEnvironment = environmentKey(target);
		try {
			const operationId = crypto.randomUUID();
			const result = await request("/api/infrastructure/incus/probe-fixtures", {
				action: "plan", ...scope(target), operationId,
			});
			const plan = result.plan as FixturePlan | undefined;
			if (typeof plan?.digest !== "string" || !/^[a-f0-9]{64}$/.test(plan.digest)) {
				throw new Error("The operator fixture plan did not include a valid review digest");
			}
			fixturePlan = plan;
			setQualificationDraft({ environmentKey: environmentKey(target), operationId,
				planDigest: plan.digest, phase: "planned", planSteps: Object.keys(plan.config?.cases ?? {}).length, scope: scope(target) });
			reviewedFixturePlan = false;
			acknowledgedQualification = false;
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : "Could not inspect the operator fixture plan";
		} finally { busy = ""; }
	}

	async function refreshFixturePlan() {
		if (!qualificationDraft || qualificationDraft.phase !== "planned") return;
		busy = "probe-plan";
		errorMessage = "";
		try {
			const result = await request("/api/infrastructure/incus/probe-fixtures", {
				action: "plan", ...qualificationDraft.scope, operationId: qualificationDraft.operationId,
			});
			const plan = result.plan as FixturePlan | undefined;
			if (!plan || plan.digest !== qualificationDraft.planDigest) throw new Error("The saved fixture plan changed. Cancel this plan and prepare it again.");
			fixturePlan = plan;
		} catch (cause) { errorMessage = cause instanceof Error ? cause.message : "Could not reload the saved fixture plan"; }
		finally { busy = ""; }
	}

	async function applyFixturePlan() {
		const target = qualificationTarget;
		if (!target || !qualificationDraft || !draftMatchesTarget || !reviewedFixturePlan) return;
		busy = "probe-apply";
		errorMessage = "";
		setQualificationDraft({ ...qualificationDraft, applyUncertain: true, applyAttempted: true });
		try {
			await request("/api/infrastructure/incus/probe-fixtures", {
				action: "apply", ...scope(target), operationId: qualificationDraft.operationId,
				planDigest: qualificationDraft.planDigest,
			});
			setQualificationDraft({ ...qualificationDraft, phase: "ready", applyUncertain: false, applyAttempted: true });
			notice = "Reviewed operator fixtures are ready. Continue to live qualification when the host is ready.";
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : "Could not apply the reviewed operator fixture plan";
			await checkFixtureStatus();
		} finally { busy = ""; }
	}

	async function checkFixtureStatus() {
		if (!qualificationDraft) return;
		busy = "probe-status";
		try {
			const result = await request("/api/infrastructure/incus/probe-fixtures", {
				action: "status", ...(qualificationTarget ? scope(qualificationTarget) : qualificationDraft.scope),
				operationId: qualificationDraft.operationId,
			});
			if (result.state === "ready" && (result.receipt as { planDigest?: string } | null)?.planDigest === qualificationDraft.planDigest) {
				setQualificationDraft({ ...qualificationDraft, phase: "ready", applyUncertain: false });
				notice = "Saved fixture status confirms the plan is ready. Remove fixtures or continue qualification.";
			} else if (result.state === "absent") {
				setQualificationDraft({ ...qualificationDraft, phase: "planned", applyUncertain: false, applyAttempted: true });
				notice = "No fixture plan is saved yet. You can retry the same apply request; its operation ID is retained.";
			} else {
				setQualificationDraft({ ...qualificationDraft, applyUncertain: true });
				errorMessage = "Fixture status is incomplete. Keep this workflow and check status again before retrying or canceling.";
			}
		} catch (cause) {
			setQualificationDraft({ ...qualificationDraft, applyUncertain: true });
			errorMessage = `${cause instanceof Error ? cause.message : "Could not confirm fixture status"} Keep this workflow and check status again before retrying or canceling.`;
		} finally { busy = ""; }
	}

	async function qualify() {
		const target = qualificationTarget;
		if (!target || !qualificationDraft || !draftMatchesTarget || qualificationDraft.phase !== "ready") return;
		busy = "qualification";
		errorMessage = "";
		const next = { ...qualificationDraft, phase: "running" as const, startedAt: Date.now() };
		setQualificationDraft(next);
		try {
			await request("/api/infrastructure/incus/qualification", {
				action: "qualify", ...scope(target), operationId: next.operationId,
			});
			notice = "Qualification started. The service may restart while it checks this environment.";
			await load({ quiet: true });
		} catch (cause) {
			errorMessage = `${cause instanceof Error ? cause.message : "The request ended before its result arrived"} Check the saved qualification status before you retry.`;
			await load({ quiet: true });
		} finally { busy = ""; }
	}

	async function cleanupQualificationFixtures() {
		const target = qualificationTarget;
		if (!qualificationDraft || !draftMatchesTarget || qualificationDraft.phase === "running"
			|| target?.qualificationState === "running") return;
		busy = "probe-cleanup";
		errorMessage = "";
		try {
			const result = await request("/api/infrastructure/incus/probe-fixtures", {
				action: "cleanup", ...(target ? scope(target) : qualificationDraft.scope), operationId: qualificationDraft.operationId,
				planDigest: qualificationDraft.planDigest,
			});
			const receipt = result.receipt as { state?: string; planDigest?: string } | undefined;
			if (receipt?.state !== "cleaned" || receipt.planDigest !== qualificationDraft.planDigest) throw new Error("Cleanup was not confirmed. Keep this workflow and check its status before retrying.");
			setQualificationDraft(null);
			fixturePlan = null;
			notice = "Temporary operator fixtures were removed.";
			await load({ quiet: true });
		} catch (cause) {
			errorMessage = cause instanceof Error ? cause.message : "Could not clean up the operator fixtures";
		} finally { busy = ""; }
	}

	function userStorageKey(name: string): string { return `ezharness-incus:${data.operatorId}:${name}`; }
	function projectDraftStorageKey(): string { return userStorageKey("project-draft"); }
	function mutationStorageKey(): string { return userStorageKey("mutation-keys"); }

	function mutationCoordinate(feature: Feature, action: string): string {
		return [feature.installationId, feature.releaseId, feature.connectionId, feature.connectionRevision ?? "?",
			feature.bindingId, feature.generation ?? "?", action].join(":");
	}

	function mutationKey(feature: Feature, action: string): string {
		const coordinate = mutationCoordinate(feature, action);
		if (mutationKeys[coordinate]) return mutationKeys[coordinate]!;
		mutationKeys[coordinate] = crypto.randomUUID();
		persistMutationKeys();
		return mutationKeys[coordinate]!;
	}

	function persistMutationKeys(): void {
		try { localStorage.setItem(mutationStorageKey(), JSON.stringify(mutationKeys)); }
		catch { /* Current page memory still holds the retry keys. */ }
	}

	function restoreMutationKeys(): void {
		try {
			const raw = localStorage.getItem(mutationStorageKey());
			if (!raw) return;
			const value = JSON.parse(raw) as Record<string, unknown>;
			mutationKeys = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
				typeof entry[1] === "string" && /^[0-9a-f-]{36}$/.test(entry[1])));
		} catch { localStorage.removeItem(mutationStorageKey()); }
	}

	function settleMutationKeys(): void {
		let changed = false;
		for (const feature of snapshot.features) {
			const state = feature.operation?.state;
			if (!feature.operation || !["SUCCEEDED", "FAILED", "REJECTED"].includes(state ?? "")) continue;
			const action = feature.operation.kind.toLowerCase().replaceAll("_", "");
			const coordinate = mutationCoordinate(feature, action);
			const normalizedCoordinate = mutationCoordinate(feature, action.replaceAll("_", ""));
			if (mutationKeys[coordinate] || mutationKeys[normalizedCoordinate]) { delete mutationKeys[coordinate];
				delete mutationKeys[normalizedCoordinate];
				changed = true; }
		}
		if (changed) persistMutationKeys();
	}

	function setProjectDraft(value: ProjectDraft | null) {
		projectDraft = value;
		try {
			if (value) localStorage.setItem(projectDraftStorageKey(), JSON.stringify(value));
			else localStorage.removeItem(projectDraftStorageKey());
		} catch { /* The current page still has the request keys in memory. */ }
	}

	function ensureProjectDraft(name: string, env: Environment): ProjectDraft {
		if (projectDraft && projectDraft.name === name && projectDraft.environmentKey === environmentKey(env)) return projectDraft;
		const draft = { name, environmentKey: environmentKey(env), prepareKey: crypto.randomUUID(), operationKey: crypto.randomUUID() };
		setProjectDraft(draft);
		return draft;
	}

	async function createSandbox() {
		const name = projectName.trim();
		if (!selected || !name) return;
		const existingDraft = projectDraft && projectDraft.name === name && projectDraft.environmentKey === environmentKey(selected);
		if (!selected.qualified && !existingDraft) return;
		busy = "prepare";
		errorMessage = "";
		notice = "";
		try {
			const draft = ensureProjectDraft(name, selected);
			const prepared = await request("/api/infrastructure/incus/features", {
				action: "prepareProject", name: draft.name, installationId: selected.installationId,
				connectionId: selected.connectionId, presetId: selected.presetId, idempotencyKey: draft.prepareKey,
			});
			const project = prepared.project as { id?: unknown } | undefined;
			const binding = prepared.binding as { id?: unknown } | undefined;
			if (typeof project?.id !== "string" || typeof binding?.id !== "string") throw new Error("The project sandbox was not prepared");
			setProjectDraft({ ...draft, projectId: project.id });
			const result = await request("/api/infrastructure/incus/features", {
				action: "create", projectId: project.id, bindingId: binding.id,
				idempotencyScope: "incus-management-ui", idempotencyKey: draft.operationKey,
			});
			notice = result.state === "QUEUED"
				? "Sandbox queued for capacity. Its status will update here."
				: result.state === "REJECTED"
					? "Sandbox creation was rejected. Check the environment and capacity, then refresh."
					: "Sandbox creation was admitted. Its status will update here.";
			await load({ quiet: true });
		} catch (cause) {
			if (cause instanceof HttpRequestError && cause.status === 409
				&& (cause.payload as { state?: unknown } | null)?.state === "REJECTED" && projectDraft?.projectId) {
				setProjectDraft({ ...projectDraft, operationKey: crypto.randomUUID() });
			}
			errorMessage = `${cause instanceof Error ? cause.message : "Could not create the project sandbox"} Refresh or retry to resume with the same project and operation keys.`;
			await load({ quiet: true });
		} finally {
			busy = "";
		}
	}

	async function featureAction(feature: Feature, action: "status" | "create" | "start" | "stop" | "destroy" | "destroyRetired") {
		if (action === "destroy") {
			destroyBinding = feature.bindingId;
			return;
		}
		const data: Record<string, unknown> = { action, projectId: feature.projectId, bindingId: feature.bindingId };
		if (["create", "start", "stop", "destroy", "destroyRetired"].includes(action)) {
			data.idempotencyScope = "incus-management-ui";
			data.idempotencyKey = mutationKey(feature, action);
		}
		await act(`${action}:${feature.bindingId}`, "/api/infrastructure/incus/features", data,
			action === "destroyRetired" ? "Cleanup was requested for this retired provider release." : undefined);
	}

	async function confirmDestroy(feature: Feature) {
		const action = feature.retired ? "destroyRetired" : "destroy";
		const body = { action, projectId: feature.projectId, bindingId: feature.bindingId,
			idempotencyScope: "incus-management-ui", idempotencyKey: mutationKey(feature, action) };
		destroyBinding = "";
		await act(`destroy:${feature.bindingId}`, "/api/infrastructure/incus/features", body,
			"Sandbox disposal was requested. Disk space is released after cleanup is confirmed.");
	}

	async function reconcile() {
		await act("reconcile", "/api/infrastructure/incus/features", { action: "reconcile", limit: 50 },
			"Reconciliation finished. Review each sandbox state before another action.");
	}

	function isUnknown(feature: Feature): boolean {
		return feature.observedState === "UNKNOWN" || feature.observedState === "ERROR"
			|| feature.operation?.state === "OUTCOME_UNKNOWN";
	}

	function isPending(feature: Feature): boolean {
		return ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING"].includes(feature.operation?.state ?? "");
	}

	function friendlyState(feature: Feature): string {
		if (feature.tombstonedAt && feature.cleanupConfirmedAt) return "Disposed";
		if (feature.tombstonedAt) return "Cleanup needs review";
		if (isPending(feature)) return feature.operation?.state === "PROVIDER_PENDING" ? "Waiting for provider" : "In progress";
		if (isUnknown(feature)) return "Needs reconciliation";
		return feature.observedState.toLowerCase();
	}

	function dateLabel(value: string | null): string {
		if (!value) return "Not qualified";
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? "Qualification date unavailable" : `Valid until ${date.toLocaleString()}`;
	}

	function resourceLabel(environment: Environment): string {
		const limits = environment.limits;
		if (!limits) return "Resource limits will appear after refresh";
		const gib = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB`;
		const cpu = limits.cpuMillis % 1000 === 0 ? `${limits.cpuMillis / 1000} vCPU` : `${limits.cpuMillis.toLocaleString()} millicores`;
		return `${gib(limits.memoryBytes)} memory · ${cpu} · ${gib(limits.diskBytes)} disk · ${limits.pids.toLocaleString()} processes`;
	}

	function restoreQualificationDraft() {
		try {
			const raw = localStorage.getItem(draftStorageKey());
			if (!raw) return;
			const value = JSON.parse(raw) as Partial<QualificationDraft>;
			if (typeof value.environmentKey === "string" && typeof value.operationId === "string"
				&& /^[0-9a-f-]{36}$/.test(value.operationId) && typeof value.planDigest === "string"
				&& /^[a-f0-9]{64}$/.test(value.planDigest) && ["planned", "ready", "running", "failed"].includes(String(value.phase))
				&& !!value.scope && typeof value.scope === "object") {
				qualificationDraft = value as QualificationDraft;
				qualifyEnvironment = value.environmentKey;
			} else recoveryWarning = "A saved qualification draft is damaged. Its local record was preserved. Do not prepare a new plan until an administrator checks the host fixture status.";
		} catch { recoveryWarning = "A saved qualification draft could not be read. Its local record was preserved. Do not prepare a new plan until an administrator checks the host fixture status."; }
	}

	function restoreProjectDraft() {
		try {
			const raw = localStorage.getItem(projectDraftStorageKey());
			if (!raw) return;
			const value = JSON.parse(raw) as Partial<ProjectDraft>;
			if (typeof value.name === "string" && typeof value.environmentKey === "string"
				&& typeof value.prepareKey === "string" && /^[0-9a-f-]{36}$/.test(value.prepareKey)
				&& typeof value.operationKey === "string" && /^[0-9a-f-]{36}$/.test(value.operationKey)
				&& (value.projectId === undefined || typeof value.projectId === "string")) {
				projectDraft = value as ProjectDraft;
				projectName = value.name;
				selectedEnvironment = value.environmentKey;
			} else recoveryWarning = "A saved project sandbox request is damaged. Its local record was preserved. Check the project and binding before creating another sandbox.";
		} catch { recoveryWarning = "A saved project sandbox request could not be read. Its local record was preserved. Check the project and binding before creating another sandbox."; }
	}

	function syncQualificationDraft() {
		if (!qualificationDraft) return;
		const environment = snapshot.environments.find(item => environmentKey(item) === qualificationDraft!.environmentKey);
		if (!environment) return;
		if (qualificationDraft.phase === "running" && environment.qualificationRunId !== qualificationDraft.operationId
			&& environment.qualificationState !== "running" && qualificationDraft.startedAt
			&& Date.now() - qualificationDraft.startedAt > 30_000) {
			setQualificationDraft({ ...qualificationDraft, phase: "ready" });
			notice = "No saved run matches this qualification request. You can retry with the same operation ID.";
			return;
		}
		if (environment.qualificationRunId !== qualificationDraft.operationId) return;
		if (environment.qualificationState === "failed" && qualificationDraft.phase === "running") {
			setQualificationDraft({ ...qualificationDraft, phase: "failed" });
			notice = "The saved live qualification run failed. Review its status before cleanup or another attempt.";
		} else if (environment.qualified && qualificationDraft.phase === "running") {
			setQualificationDraft({ ...qualificationDraft, phase: "ready" });
			notice = "Live qualification passed. Remove its temporary operator fixtures.";
		}
	}

	function fixtureRecords(): Array<{ name: string; projectId?: string; bindingId?: string; canaryPath?: string }> {
		return Object.entries(fixturePlan?.config?.cases ?? {}).map(([name, item]) => ({ name, ...item }));
	}

	onMount(() => {
		restoreQualificationDraft();
		restoreProjectDraft();
		restoreMutationKeys();
		void load();
		if (qualificationDraft?.phase === "planned" && qualificationDraft.applyAttempted) void checkFixtureStatus();
		else if (qualificationDraft?.phase === "planned") void refreshFixturePlan();
		pollTimer = setInterval(() => {
			if (qualificationDraft?.phase === "running" || snapshot.environments.some(environment => environment.qualificationState === "running")
				|| snapshot.features.some(isPending)) void load({ quiet: true });
		}, 5_000);
		return () => { if (pollTimer) clearInterval(pollTimer); };
	});
</script>

<svelte:head>
	<title>Incus sandboxes · EZHarness</title>
</svelte:head>

<main class="management-shell" data-testid="incus-management-page">
	<header class="page-header">
		<div class="eyebrow">INFRASTRUCTURE / INCUS</div>
		<div class="header-row">
			<div><h1>Incus sandboxes</h1><p>Review qualified environments and manage project workspaces.</p></div>
			<a href="/extensions/incus-setup">Server setup</a>
		</div>
	</header>

	{#if errorMessage}<p class="alert error" role="alert">{errorMessage}</p>{/if}
	{#if recoveryWarning}<p class="alert error" role="alert">{recoveryWarning}</p>{/if}
	{#if notice}<p class="alert notice" role="status">{notice}</p>{/if}

	<section class="panel" aria-labelledby="environment-title">
		<div class="section-heading"><div><h2 id="environment-title">Environments</h2><p>A preset can create sandboxes only after its live qualification passes.</p></div>
			<button class="quiet" onclick={() => void load()} disabled={loading || !!busy}>Refresh</button></div>
		{#if loading}<p class="empty">Loading approved environments…</p>
		{:else if !snapshot.environments.length}<div class="empty"><strong>No approved Incus environment found.</strong><p>Install and approve the Incus provider, then complete server setup.</p><a href="/extensions">Open extensions</a></div>
		{:else}
			<div class="environment-list">
				{#each snapshot.environments as environment (environmentKey(environment))}
					<article class="environment-card" class:chosen={selectedEnvironment === environmentKey(environment)}>
						<div class="env-top"><div><h3>{environment.label}</h3><p>{environment.profile} · preset {environment.presetId}</p></div>
							<span class="pill" class:good={environment.qualified} class:waiting={environment.qualificationState === "running"}>{environment.qualificationState === "running" ? "Qualifying" : environment.qualified ? "Qualified" : "Not qualified"}</span>
						</div>
						<p class="qualification-date">{dateLabel(environment.qualificationValidUntil)}</p>
						<p class="qualification-date">Limits: {resourceLabel(environment)}</p>
						{#if environment.blockedReason}<p class="blocked-reason">{environment.blockedReason}</p>{/if}
						<div class="env-actions">
							<button class="quiet" onclick={() => selectedEnvironment = environmentKey(environment)} aria-pressed={selectedEnvironment === environmentKey(environment)}>Use this environment</button>
							{#if !environment.qualified && environment.qualificationState !== "running" && !qualificationDraft}
							<button class="secondary" disabled={!!busy || !!recoveryWarning} onclick={() => void planQualification(environment)}>{busy === "probe-plan" && qualifyEnvironment === environmentKey(environment) ? "Planning…" : "Prepare qualification…"}</button>
							{:else if !environment.qualified && qualificationDraft && !draftMatchesTarget}
							<span class="muted">Finish the current fixture cleanup before preparing another environment.</span>
							{:else if environment.qualificationState === "running"}<span class="muted">This may restart the service. This page will refresh the result.</span>{/if}
						</div>
					</article>
				{/each}
			</div>
		{/if}
		{#if selected?.setupId}<IncusCapacityPanel setupId={selected.setupId} onapplied={() => void load({ quiet: true })} />{/if}
		{#if qualificationDraft && draftMatchesTarget}
			<div class="confirm-box" data-testid="qualification-workflow">
				{#if qualificationDraft.phase === "planned"}
					<strong>Review the temporary operator fixture plan</strong>
					{#if !fixturePlan}<p>The saved plan details are loading before review.</p><button class="quiet" disabled={!!busy} onclick={() => void refreshFixturePlan()}>Reload saved plan</button>
					{:else}<p>The plan creates {qualificationDraft.planSteps || 4} private control checks for admission denials. Review the exact host effects before applying.</p>
					<dl class="plan-summary"><div><dt>Host directory</dt><dd><code>{fixturePlan.directory ?? "Not provided"}</code></dd></div><div><dt>Plan scope</dt><dd><code>{JSON.stringify(fixturePlan.scope ?? qualificationDraft.scope)}</code></dd></div><div><dt>Provider profile</dt><dd>{fixturePlan.profile ?? qualificationTarget?.profile ?? "Not provided"}</dd></div><div><dt>Connection revision</dt><dd>{fixturePlan.connectionRevision ?? "Not provided"}</dd></div><div><dt>Provider generation</dt><dd>{fixturePlan.providerGeneration ?? "Not provided"}</dd></div><div><dt>Unqualified preset</dt><dd><code>{fixturePlan.config?.unqualifiedPresetId ?? "Not provided"}</code></dd></div><div><dt>Review digest</dt><dd><code>{qualificationDraft.planDigest}</code></dd></div></dl>
						<ul class="fixture-records">{#each fixtureRecords() as record}<li><strong>{record.name}</strong> · project <code>{record.projectId ?? "Not provided"}</code> · binding <code>{record.bindingId ?? "Not provided"}</code> · canary <code>{record.canaryPath ?? "Not provided"}</code></li>{/each}</ul>{/if}
					<label class="review-check"><input type="checkbox" bind:checked={reviewedFixturePlan} />I reviewed this plan and its host-side test records.</label>
					{#if qualificationDraft.applyUncertain}<p>The last apply reply was not confirmed. Check the saved fixture status before you retry or cancel.</p>{/if}
					<div class="button-row">{#if qualificationDraft.applyUncertain}<button class="quiet" disabled={!!busy} onclick={() => void checkFixtureStatus()}>{busy === "probe-status" ? "Checking…" : "Check fixture status"}</button>{:else}<button class="primary" disabled={!!busy || !reviewedFixturePlan || !fixturePlan} onclick={() => void applyFixturePlan()}>{busy === "probe-apply" ? "Applying…" : qualificationDraft.applyAttempted ? "Retry same apply" : "Apply reviewed fixture plan"}</button>{#if !qualificationDraft.applyAttempted}<button class="quiet" disabled={!!busy} onclick={() => { setQualificationDraft(null); fixturePlan = null; }}>Cancel</button>{/if}{/if}</div>
				{:else if qualificationDraft.phase === "ready" && !qualificationTarget?.qualified}
					<strong>Operator fixtures are ready</strong>
					<p>Live qualification tests guest isolation, resource limits, restart recovery, and cleanup. It uses temporary sandboxes and may restart EZHarness. It can take several minutes.</p>
					<label class="review-check"><input type="checkbox" bind:checked={acknowledgedQualification} />The host is ready for a live sandbox qualification run.</label>
					<div class="button-row"><button class="primary" disabled={!!busy || !acknowledgedQualification || !qualificationTarget} onclick={() => void qualify()}>{busy === "qualification" ? "Starting…" : "Run live qualification"}</button><button class="quiet" disabled={!!busy} onclick={() => void cleanupQualificationFixtures()}>Remove fixtures</button></div>
				{:else if qualificationTarget?.qualificationState === "running" || qualificationDraft.phase === "running"}
					<strong>Qualification status is being checked</strong><p>The service may restart while the host checks this environment. The saved status is checked automatically. If no run was saved, this request can be retried with the same operation ID.</p>
					<div class="button-row"><button class="quiet" disabled={!!busy} onclick={() => void load()}>{loading ? "Checking…" : "Check saved status"}</button>{#if qualificationDraft.phase === "ready"}<button class="primary" disabled={!!busy || !acknowledgedQualification || !qualificationTarget} onclick={() => void qualify()}>Retry same qualification</button>{/if}</div>
				{:else if qualificationTarget?.qualified}
					<strong>Qualification passed</strong><p>The saved qualification is current for this provider release, connection revision, and preset. Remove the temporary operator fixtures.</p>
					<button class="secondary" disabled={!!busy} onclick={() => void cleanupQualificationFixtures()}>{busy === "probe-cleanup" ? "Cleaning…" : "Remove qualification fixtures"}</button>
				{:else}
					<strong>Qualification did not complete</strong><p>Review the saved run before you try again. Remove its temporary operator fixtures when the run is no longer active.</p>
					<button class="secondary" disabled={!!busy} onclick={() => void cleanupQualificationFixtures()}>Remove qualification fixtures</button>
				{/if}
			</div>
		{/if}
	</section>

	<section class="panel" aria-labelledby="project-sandbox-title">
		<div class="section-heading"><div><h2 id="project-sandbox-title">Project sandboxes</h2><p>Create a named project with one isolated Incus workspace.</p></div>
			{#if snapshot.features.some(feature => isUnknown(feature) || isPending(feature))}<button class="secondary" disabled={!!busy} onclick={() => void reconcile()}>{busy === "reconcile" ? "Reconciling…" : "Reconcile pending work"}</button>{/if}
		</div>
		{#if snapshot.truncated}<p class="blocked-reason">Some environments or projects are not shown. Narrow the list before creating a sandbox.</p>{/if}
		{#if eligibleEnvironments.length}
			<div class="create-row">
				<label>Qualified environment<select bind:value={selectedEnvironment} disabled={!!busy}>
					{#each eligibleEnvironments as environment (environmentKey(environment))}
						<option value={environmentKey(environment)} disabled={!environment.qualified}>{environment.label} · {environment.presetId}{environment.qualified ? "" : " · qualification required"}</option>
					{/each}
				</select></label>
				<label>New project name<input bind:value={projectName} maxlength="120" disabled={!!busy} placeholder="Payments prototype" /></label>
				<button class="primary" disabled={!!busy || !!recoveryWarning || !selected?.qualified || !projectName.trim()} onclick={() => void createSandbox()}>{busy === "prepare" ? "Creating…" : "Create project sandbox"}</button>
			</div>
			<p class="muted empty-workspace-note">The new project starts with an empty workspace. Existing project files and Git checkouts are not copied.</p>
		{:else}<p class="empty">No active environment is available. Review provider setup and qualification above.</p>{/if}

		{#if snapshot.features.length}
			<div class="feature-list">
				{#each snapshot.features as feature (feature.bindingId)}
					<article class="feature-card">
						<div class="feature-heading"><div><h3>{feature.projectName}</h3><p>{feature.presetId} · {feature.observedState.toLowerCase()} observed</p></div>
							<span class="pill" class:good={(feature.observedState === "RUNNING" || feature.observedState === "STOPPED") && !isPending(feature) && !isUnknown(feature)} class:waiting={isPending(feature)} class:warning={isUnknown(feature) || !!feature.tombstonedAt}>{friendlyState(feature)}</span>
						</div>
						{#if feature.operation}<p class="operation">Last operation: {feature.operation.kind} · {feature.operation.state}{#if feature.operation.errorCode} · {feature.operation.errorCode}{/if}</p>{:else}<p class="operation">No lifecycle operation recorded.</p>{/if}
						<div class="feature-actions">
							<button class="quiet" disabled={!!busy} onclick={() => void featureAction(feature, "status")}>Refresh status</button>
							{#if feature.observedState === "RUNNING" && feature.desiredState === "RUNNING" && !feature.tombstonedAt && !isPending(feature) && !isUnknown(feature)}<a class="chat-link" href={`/project/${encodeURIComponent(feature.projectId)}`}>Open chat</a>{/if}
							{#if !feature.tombstonedAt && !isUnknown(feature) && !isPending(feature)}
								{#if feature.observedState === "RUNNING"}<button class="secondary" disabled={!!busy} onclick={() => void featureAction(feature, "stop")}>Stop</button>
								{:else if feature.observedState === "STOPPED"}<button class="secondary" disabled={!!busy} onclick={() => void featureAction(feature, "start")}>Start</button>
								{:else if feature.observedState === "ABSENT"}<button class="secondary" disabled={!!busy} onclick={() => void featureAction(feature, "create")}>Create guest</button>{/if}
							{/if}
							{#if feature.tombstonedAt && !feature.cleanupConfirmedAt}<button class="secondary" disabled={!!busy} onclick={() => void featureAction(feature, "destroyRetired")}>Retry cleanup</button>
							{:else if !feature.tombstonedAt && !isUnknown(feature) && !isPending(feature)}<button class="danger-link" disabled={!!busy} onclick={() => void featureAction(feature, "destroy")}>Dispose…</button>{/if}
						</div>
						{#if destroyBinding === feature.bindingId}
							<div class="confirm-box compact" role="group" aria-label={`Confirm disposal of ${feature.projectName}`}><strong>Dispose this project sandbox?</strong><p>This permanently removes its workspace data. The project remains, but its sandbox changes cannot be recovered.</p><div class="button-row"><button class="danger" disabled={!!busy} onclick={() => void confirmDestroy(feature)}>Dispose sandbox</button><button class="quiet" onclick={() => destroyBinding = ""}>Cancel</button></div></div>
						{/if}
					</article>
				{/each}
			</div>
		{:else}<p class="empty">No project sandboxes yet. Choose a qualified environment and name a project to create one.</p>{/if}
	</section>
</main>

<style>
	.management-shell{max-width:1120px;margin:0 auto;padding:32px 24px 96px;color:var(--color-text-primary)}
	.page-header{margin-bottom:24px}.eyebrow{font-size:11px;letter-spacing:.16em;font-weight:700;color:var(--color-accent,#82b5ff)}
	.header-row,.section-heading,.env-top,.feature-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
	.header-row{margin-top:10px}.header-row h1{font-size:clamp(28px,4vw,40px);line-height:1.1;letter-spacing:-.03em;margin:0}.header-row p,.section-heading p{margin:7px 0 0;color:var(--color-text-muted);font-size:14px}
	.header-row>a{padding:9px 12px;border:1px solid var(--color-border);border-radius:7px;color:var(--color-text-secondary);font-size:13px;text-decoration:none;white-space:nowrap}
	.panel{background:var(--color-surface,#171b23);border:1px solid var(--color-border);border-radius:12px;padding:22px;margin:16px 0;box-shadow:0 10px 32px rgba(0,0,0,.07)}
	.section-heading{margin-bottom:18px}.section-heading h2{font-size:19px;margin:0}.section-heading p{font-size:13px}
	.environment-list,.feature-list{display:grid;gap:12px}.environment-card,.feature-card{border:1px solid var(--color-border);border-radius:9px;padding:16px;background:var(--color-surface-secondary)}
	.environment-card.chosen{border-color:var(--color-accent,#82b5ff);box-shadow:0 0 0 1px color-mix(in srgb,var(--color-accent,#82b5ff) 35%,transparent)}
	h3{font-size:15px;margin:0}.env-top p,.feature-heading p{font:12px ui-monospace,monospace;color:var(--color-text-muted);margin:5px 0 0;overflow-wrap:anywhere}
	.pill{flex:none;border:1px solid var(--color-border);border-radius:999px;padding:5px 9px;font-size:11px;color:var(--color-text-muted)}.pill.good{border-color:#19875466;color:#52bf83;background:#19875412}.pill.waiting{border-color:#2a74bf66;color:#82b5ff}.pill.warning{border-color:#cb7b3566;color:#e7a765;background:#cb7b3512}
	.qualification-date,.operation{font-size:12px;color:var(--color-text-muted);margin:10px 0}.blocked-reason{font-size:12px;color:#7a3e00;background:#fff3df;border:1px solid #e8c38f;border-radius:6px;padding:9px 11px;margin:10px 0}
	.plan-summary{display:grid;gap:8px;margin:14px 0}.plan-summary div{display:grid;grid-template-columns:minmax(130px,180px) 1fr;gap:10px}.plan-summary dt{font-weight:650;color:var(--color-text-muted)}.plan-summary dd{margin:0;overflow-wrap:anywhere}.fixture-records{display:grid;gap:8px;padding-left:20px;font-size:13px}.fixture-records li{overflow-wrap:anywhere}
	:global(.dark) .blocked-reason{color:#ffd19a;background:#4b2c0e;border-color:#80501d}
	.env-actions,.feature-actions,.button-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.feature-actions{margin-top:12px}.muted{font-size:12px;color:var(--color-text-muted)}.chat-link{display:inline-flex;align-items:center;padding:9px 12px;border-radius:7px;border:1px solid var(--color-border);font-size:12px;color:var(--color-text-secondary);text-decoration:none}.chat-link:hover{background:var(--color-surface-tertiary)}
	.create-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1fr) auto;align-items:end;gap:12px;padding:16px;border:1px solid var(--color-border);border-radius:9px;margin-bottom:16px;background:var(--color-surface-secondary)}
	.create-row label{display:grid;gap:7px;font-size:12px;font-weight:700}.create-row select,.create-row input{min-width:0;width:100%;padding:10px;border-radius:7px;background:var(--color-surface,#171b23);border:1px solid var(--color-border);color:var(--color-text-primary)}.empty-workspace-note{margin:0 0 16px}
	button{border-radius:7px;padding:9px 12px;font-size:12px;font-weight:700;cursor:pointer}button:disabled{opacity:.48;cursor:not-allowed}.primary{border:0;background:var(--color-accent,#82b5ff);color:#101722}.secondary{border:1px solid var(--color-border);background:var(--color-surface-tertiary);color:var(--color-text-primary)}.quiet{border:1px solid var(--color-border);background:transparent;color:var(--color-text-secondary)}.danger{border:0;background:#a63c33;color:white}.danger-link{margin-left:auto;border:0;background:transparent;color:#d97870}.alert,.empty{padding:14px 16px;border:1px solid var(--color-border);border-radius:7px;color:var(--color-text-muted);font-size:13px}.alert{margin:14px 0}.alert.error{border-color:#c44a4a66;background:#c44a4a12;color:#d97870}.alert.notice{border-color:#4183c466;background:#4183c412;color:var(--color-text-secondary)}
	.empty p{margin:7px 0}.empty a{display:inline-block;margin-top:10px;color:var(--color-accent,#82b5ff);font-weight:700}.confirm-box{margin-top:16px;padding:15px;border:1px solid #cb7b3566;border-radius:8px;background:#cb7b3510}.confirm-box p{font-size:13px;line-height:1.5;color:var(--color-text-secondary);margin:7px 0 12px}.confirm-box.compact{margin-top:14px}.confirm-box.compact p{max-width:650px}
	.confirm-box code{font:11px ui-monospace,monospace;overflow-wrap:anywhere;color:var(--color-text-secondary)}.review-check{display:flex;gap:9px;align-items:flex-start;margin:12px 0;font-size:12px;color:var(--color-text-secondary)}.review-check input{margin-top:2px;accent-color:var(--color-accent,#82b5ff)}
	@media(max-width:700px){.management-shell{padding:22px 14px 64px}.panel{padding:16px}.header-row{align-items:flex-start}.header-row>a{font-size:12px}.create-row{grid-template-columns:1fr}.create-row button{width:100%}.section-heading{align-items:flex-start}.feature-actions .danger-link{margin-left:0}}
</style>
