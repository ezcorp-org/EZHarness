<script lang="ts">
	import { page } from "$app/state";
	import { store, setActiveProjectId } from "$lib/stores.svelte.js";
	import ModelSelector from "$lib/components/ModelSelector.svelte";

	// ── Per-project scoping ────────────────────────────────────────────────
	// This page is scoped to ONE EZCorp project; we surface the project name in
	// the header so the scoping is visible. `activeProjectId` is synced so the
	// rest of the shell (sidebar nav) tracks the URL.
	$effect(() => {
		setActiveProjectId(page.params.id ?? null);
	});
	let projectId = $derived(page.params.id ?? "");
	let project = $derived(store.projects.find((p) => p.id === projectId));
	let projectName = $derived(project?.name ?? projectId);

	// ── Types (kept local; mirror the server response shapes) ──────────────
	type StatusOption = { id: string; name: string };
	type ColumnAction = {
		action: "plan" | "execute";
		autoSpawn: boolean;
		agentName?: string;
		permissionMode?: "default" | "plan" | "acceptEdits";
	};
	type Link = {
		id: string;
		projectId: string;
		boardUrl: string;
		boardTitle: string;
		ownerLogin: string;
		boardNodeId: string;
		statusFieldId: string | null;
		statusOptions: StatusOption[];
		defaultModel: string | null;
		authMode: "pat" | "gh";
		columnActionMap: Record<string, ColumnAction>;
		pollIntervalSec: number;
		enabled: boolean;
		lastError: string | null;
	};
	// ── Component state ────────────────────────────────────────────────────
	let loading = $state(true);
	let link = $state<Link | null>(null);
	// statusOptions only known right after a connect (the board ref carries
	// them). For an existing link we render the saved map's keys.
	let statusOptions = $state<StatusOption[]>([]);

	// Connect form
	let boardUrl = $state("");
	let authMode = $state<"pat" | "gh">("pat");
	let token = $state("");
	let connecting = $state(false);
	let connectError = $state("");
	let missingScopes = $state<string[]>([]);
	let grantedScopes = $state<string[]>([]);

	// Save-flash for the column map / interval / pause editor.
	let savingMap = $state(false);
	let mapFlash = $state(false);
	let pausing = $state(false);
	let disconnecting = $state(false);

	// Refresh-columns: re-fetch the board's Status columns from GitHub host-side
	// (no PAT re-entry) and persist them. Self-heals a link whose columns were
	// never stored (status_options = []), so the editor renders named, complete
	// columns instead of raw option-ids with unmapped columns dropped.
	let refreshingColumns = $state(false);
	let refreshError = $state("");

	// Replace-token affordance (PAT mode only). The stored token is never
	// sent to the client — the connected state shows a generic masked
	// indicator (`•••••••• saved`), and "Replace token" re-reveals the
	// password input so the user can paste a NEW PAT and re-run the existing
	// connect() flow (which overwrites the stored secret host-side).
	let replacingToken = $state(false);

	function startReplaceToken() {
		// Pre-fill the board URL from the saved link so connect()'s
		// non-empty-URL guard passes; the user only needs to paste the PAT.
		if (link) boardUrl = link.boardUrl;
		token = "";
		connectError = "";
		replacingToken = true;
	}

	function cancelReplaceToken() {
		replacingToken = false;
		token = "";
		connectError = "";
	}

	// Working copy of the column→action map the user edits.
	let columnMap = $state<Record<string, ColumnAction>>({});

	// Default model for spawned runs ("<provider>:<model>"; "" = instance
	// default). Initialized from the loaded link; saved with the column map.
	let defaultModel = $state<string>("");
	// <ModelSelector> works in {provider, model} terms, so derive its selection
	// from the persisted string — split on the FIRST ":" to mirror the server's
	// parseDefaultModel (so "ollama:gemma4:e2b" → model "gemma4:e2b").
	let selectedModel = $derived.by((): { provider: string; model: string } | null => {
		const raw = defaultModel.trim();
		const i = raw.indexOf(":");
		if (i <= 0 || i === raw.length - 1) return null;
		return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
	});

	async function loadLink() {
		loading = true;
		try {
			const res = await fetch(
				`/api/integrations/github-projects/link?projectId=${encodeURIComponent(projectId)}`,
			);
			if (res.ok) {
				const data = (await res.json()) as { link: Link };
				link = data.link;
				columnMap = { ...data.link.columnActionMap };
				defaultModel = data.link.defaultModel ?? "";
				// Self-heal a legacy/empty link: when the board's columns were never
				// persisted (status_options = []) the editor would fall back to raw
				// option-ids with unmapped columns dropped. Re-fetch them host-side so
				// it renders named, complete columns. Kept inside `loading` so the user
				// never sees the id-only flash.
				if (!data.link.statusOptions?.length) {
					await refreshColumns();
				}
			} else {
				link = null;
			}
		} catch {
			link = null;
		} finally {
			loading = false;
		}
	}

	// Re-fetch the board's Status columns host-side (no PAT re-entry) and persist
	// them. On success the loaded `link` carries the refreshed statusOptions, so
	// `editableColumns` renders named, complete columns.
	async function refreshColumns() {
		if (!link || refreshingColumns) return;
		refreshingColumns = true;
		refreshError = "";
		try {
			const res = await fetch("/api/integrations/github-projects/link/refresh-columns", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId }),
			});
			if (res.ok) {
				const data = (await res.json()) as { link: Link };
				link = data.link;
				// A connect() this session may have stale statusOptions; clear them so
				// `editableColumns` prefers the freshly-persisted link columns.
				statusOptions = [];
			} else {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				refreshError = data.error ?? `Refresh failed (${res.status})`;
			}
		} catch (e) {
			refreshError = e instanceof Error ? e.message : "Refresh failed";
		} finally {
			refreshingColumns = false;
		}
	}

	$effect(() => {
		if (projectId) loadLink();
	});

	async function connect() {
		connectError = "";
		missingScopes = [];
		grantedScopes = [];
		if (!boardUrl.trim()) {
			connectError = "Paste a GitHub Projects board URL first.";
			return;
		}
		connecting = true;
		try {
			const res = await fetch("/api/integrations/github-projects/connect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectId,
					boardUrl: boardUrl.trim(),
					authMode,
					token: authMode === "pat" ? token : undefined,
				}),
			});
			const data = (await res.json().catch(() => ({}))) as {
				error?: string;
				missingScopes?: string[];
				scopes?: string[];
				statusOptions?: StatusOption[];
			};
			if (!res.ok) {
				connectError = data.error ?? `Connect failed (${res.status})`;
				missingScopes = data.missingScopes ?? [];
				return;
			}
			grantedScopes = data.scopes ?? [];
			statusOptions = data.statusOptions ?? [];
			token = ""; // never keep the PAT in memory longer than the request
			replacingToken = false; // exit replace-token mode on success
			await loadLink();
		} catch (e) {
			connectError = e instanceof Error ? e.message : "Connect failed";
		} finally {
			connecting = false;
		}
	}

	// Columns to render in the editor, in priority order:
	//   1. board options freshly resolved by connect() (this session), else
	//   2. the board options PERSISTED on the link (survive a page reload), else
	//   3. last-resort: the saved map's option-id keys (only if a legacy link
	//      predates persisted statusOptions — shows ids, mapped columns only).
	// Without (2) a reload fell back to (3), which showed option ids as names
	// and dropped every unmapped column.
	let editableColumns = $derived.by((): StatusOption[] => {
		if (statusOptions.length) return statusOptions;
		if (link?.statusOptions?.length) return link.statusOptions;
		return Object.keys(columnMap).map((id) => ({ id, name: id }));
	});

	function toggleColumnEnabled(optionId: string, on: boolean) {
		if (on) {
			columnMap = {
				...columnMap,
				[optionId]: columnMap[optionId] ?? { action: "plan", autoSpawn: false },
			};
		} else {
			const next = { ...columnMap };
			delete next[optionId];
			columnMap = next;
		}
	}

	function setColumnField<K extends keyof ColumnAction>(
		optionId: string,
		key: K,
		value: ColumnAction[K],
	) {
		const existing = columnMap[optionId] ?? { action: "plan", autoSpawn: false };
		columnMap = { ...columnMap, [optionId]: { ...existing, [key]: value } };
	}

	async function saveMap() {
		if (!link) return;
		savingMap = true;
		mapFlash = false;
		try {
			const res = await fetch("/api/integrations/github-projects/link", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId, columnActionMap: columnMap, defaultModel: defaultModel || null }),
			});
			if (res.ok) {
				const data = (await res.json()) as { link: Link };
				link = data.link;
				columnMap = { ...data.link.columnActionMap };
				defaultModel = data.link.defaultModel ?? "";
				mapFlash = true;
				setTimeout(() => (mapFlash = false), 1500);
			}
		} finally {
			savingMap = false;
		}
	}

	async function togglePause() {
		if (!link) return;
		pausing = true;
		try {
			const res = await fetch("/api/integrations/github-projects/link", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId, enabled: !link.enabled }),
			});
			if (res.ok) {
				const data = (await res.json()) as { link: Link };
				link = data.link;
			}
		} finally {
			pausing = false;
		}
	}

	async function disconnect() {
		if (!link) return;
		if (!confirm("Disconnect this GitHub board? The stored token is purged and active proposals are cancelled.")) {
			return;
		}
		disconnecting = true;
		try {
			const res = await fetch("/api/integrations/github-projects/link", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId }),
			});
			if (res.ok) {
				link = null;
				columnMap = {};
				statusOptions = [];
				grantedScopes = [];
				boardUrl = "";
			}
		} finally {
			disconnecting = false;
		}
	}

	// Is any mapped column set to auto-spawn? Drives the loud global warning.
	let anyAutoSpawn = $derived(Object.values(columnMap).some((c) => c.autoSpawn));
</script>

<svelte:head>
	<title>GitHub Projects - {projectName} - EZCorp</title>
</svelte:head>

<div class="space-y-6" data-testid="gh-projects-page">
	<header>
		<p class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Integration · Project</p>
		<h1 class="text-2xl font-bold text-[var(--color-text-primary)]" data-testid="gh-projects-project-name">
			GitHub Projects — {projectName}
		</h1>
		<p class="mt-1 text-sm text-[var(--color-text-secondary)]">
			Connect a GitHub Projects board to this project. Moving a card into a mapped
			column proposes (or, if you opt in, auto-spawns) an AI agent run.
		</p>
	</header>

	{#if loading}
		<p class="text-[var(--color-text-muted)]" data-testid="gh-projects-loading">Loading…</p>
	{:else if link}
		<!-- ── Connected state ─────────────────────────────────────────── -->
		<section
			class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6"
			data-testid="gh-projects-connected"
		>
			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="text-lg font-semibold text-green-400" data-testid="gh-projects-connected-banner">
						Connected: {link.boardTitle} ✓
					</p>
					<p class="text-xs text-[var(--color-text-secondary)]">
						{link.ownerLogin} · auth mode: {link.authMode === "pat" ? "fine-grained PAT" : "gh CLI identity"}
						{#if !link.enabled}
							· <span class="text-amber-400" data-testid="gh-projects-paused-tag">paused</span>
						{/if}
					</p>
					{#if link.authMode === "pat"}
						<!--
							Masked saved-state. The stored PAT is purposely never
							returned to the client (host-side encrypted broker), so
							we render a GENERIC masked indicator rather than any real
							token characters. "Replace token" re-reveals the input.
						-->
						<p class="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]" data-testid="gh-projects-token-masked">
							<span class="font-mono tracking-widest text-[var(--color-text-muted)]">••••••••</span>
							<span>saved</span>
							{#if !replacingToken}
								<button
									type="button"
									onclick={startReplaceToken}
									data-testid="gh-projects-replace-token"
									class="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)]"
								>
									Replace token
								</button>
							{/if}
						</p>
					{/if}
					{#if grantedScopes.length}
						<p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="gh-projects-granted-scopes">
							Granted scopes: {grantedScopes.join(", ")}
						</p>
					{/if}
					{#if link.lastError}
						<p class="mt-1 text-xs text-red-400" data-testid="gh-projects-health-error">
							Last error: {link.lastError}
						</p>
					{/if}
				</div>
				<div class="flex shrink-0 gap-2">
					<button
						type="button"
						onclick={togglePause}
						disabled={pausing}
						data-testid="gh-projects-pause"
						class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
					>
						{pausing ? "…" : link.enabled ? "Pause polling" : "Resume polling"}
					</button>
					<button
						type="button"
						onclick={disconnect}
						disabled={disconnecting}
						data-testid="gh-projects-disconnect"
						class="rounded-md px-3 py-1.5 text-sm text-red-400 hover:bg-[var(--color-surface-tertiary)] hover:text-red-300 disabled:opacity-50"
					>
						{disconnecting ? "…" : "Disconnect"}
					</button>
				</div>
			</div>

			{#if replacingToken}
				<!--
					Replace-token inline form. Re-uses the existing connect()
					flow: the board URL is pre-filled from the saved link, so the
					user only pastes a NEW fine-grained PAT and submits. connect()
					overwrites the host-side secret and exits this mode.
				-->
				<div class="mt-4 border-t border-[var(--color-border)] pt-4" data-testid="gh-projects-replace-form">
					<label class="block text-sm text-[var(--color-text-secondary)]">
						New token
						<input
							type="password"
							bind:value={token}
							autocomplete="off"
							placeholder="github_pat_…"
							data-testid="gh-projects-token"
							class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
						/>
					</label>
					{#if connectError}
						<p class="mt-2 text-sm text-red-400" data-testid="gh-projects-connect-error">{connectError}</p>
					{/if}
					<div class="mt-3 flex gap-2">
						<button
							type="button"
							onclick={connect}
							disabled={connecting}
							data-testid="gh-projects-replace-submit"
							class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
						>
							{connecting ? "Saving…" : "Save new token"}
						</button>
						<button
							type="button"
							onclick={cancelReplaceToken}
							disabled={connecting}
							data-testid="gh-projects-replace-cancel"
							class="rounded-md px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
						>
							Cancel
						</button>
					</div>
				</div>
			{/if}
		</section>

		<!-- ── Column → action mapping editor ──────────────────────────── -->
		<section
			class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6"
			data-testid="gh-projects-column-editor"
		>
			<div class="flex items-start justify-between gap-3">
				<h2 class="text-lg font-semibold text-[var(--color-text-primary)]">Column → action mapping</h2>
				<!--
					Re-fetch the board's Status columns from GitHub (host-side, no PAT
					re-entry). Use it when the columns show as raw ids / a column is
					missing (a link that predates column persistence), or after the
					board owner adds / renames / removes a column.
				-->
				<button
					type="button"
					onclick={refreshColumns}
					disabled={refreshingColumns}
					data-testid="gh-projects-refresh-columns"
					title="Re-fetch this board's columns from GitHub"
					class="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
				>
					{refreshingColumns ? "Refreshing…" : "Refresh columns"}
				</button>
			</div>
			<p class="mt-1 mb-4 text-sm text-[var(--color-text-secondary)]">
				When a card moves into a mapped column, EZCorp spawns an AI agent that can
				run tools. Auto-spawn is <strong>off by default</strong> — a card move creates
				a proposal you approve on the Hub.
			</p>

			{#if refreshError}
				<p class="mb-4 text-sm text-red-400" data-testid="gh-projects-refresh-error">{refreshError}</p>
			{/if}

			{#if anyAutoSpawn}
				<p
					class="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
					data-testid="gh-projects-autospawn-warning"
				>
					⚠ Auto-spawn is enabled on one or more columns. A card moving there will
					launch a tool-running agent with <strong>no human approval step</strong>.
				</p>
			{/if}

			<div class="space-y-3">
				{#each editableColumns as col (col.id)}
					{@const mapped = columnMap[col.id]}
					<div class="rounded-md border border-[var(--color-border)] p-3" data-testid="gh-projects-column-row">
						<label class="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
							<input
								type="checkbox"
								checked={!!mapped}
								onchange={(e) => toggleColumnEnabled(col.id, e.currentTarget.checked)}
								data-testid={`gh-projects-column-enable-${col.id}`}
							/>
							<span class="font-medium">{col.name}</span>
						</label>
						{#if mapped}
							<div class="mt-2 flex flex-wrap items-center gap-4 pl-6">
								<label class="text-xs text-[var(--color-text-secondary)]">
									Action
									<select
										value={mapped.action}
										onchange={(e) => setColumnField(col.id, "action", e.currentTarget.value as "plan" | "execute")}
										data-testid={`gh-projects-column-action-${col.id}`}
										class="ml-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
									>
										<option value="plan">plan</option>
										<option value="execute">execute</option>
									</select>
								</label>
								<label class="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
									<input
										type="checkbox"
										checked={mapped.autoSpawn}
										onchange={(e) => setColumnField(col.id, "autoSpawn", e.currentTarget.checked)}
										data-testid={`gh-projects-column-autospawn-${col.id}`}
									/>
									Auto-spawn (no approval)
								</label>
							</div>
						{/if}
					</div>
				{/each}
				{#if editableColumns.length === 0}
					<p class="text-sm text-[var(--color-text-muted)]">
						Re-connect the board to load its columns.
					</p>
				{/if}
			</div>

			<!-- ── Default model for spawned runs ──────────────────────────── -->
			<div class="mt-6 border-t border-[var(--color-border)] pt-4">
				<span class="block text-sm text-[var(--color-text-secondary)]">Default model for spawned runs</span>
				<!--
					Reuses the SAME <ModelSelector> the chat composer (ChatInput) uses,
					so the affordance matches chat exactly (and avoids the bespoke
					<select> + /api/models fetch this page used to carry). `defaultModel`
					stays the persisted "<provider>:<model>" string ("" = instance
					default); NO onautoselect is passed, so the empty state stays
					"instance default" instead of auto-picking the first model.
				-->
				<div class="mt-2 flex flex-wrap items-center gap-3" data-testid="gh-projects-default-model">
					<ModelSelector
						selected={selectedModel}
						onselect={(provider, model) => {
							defaultModel = `${provider}:${model}`;
						}}
					/>
					{#if defaultModel}
						<button
							type="button"
							onclick={() => {
								defaultModel = "";
							}}
							data-testid="gh-projects-default-model-clear"
							class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
						>
							Use instance default
						</button>
					{:else}
						<!--
							Active "instance default" state — an accent chip with a check so
							clicking "Use instance default" (or landing here by default) gives
							an unmistakable "this is the selected choice" confirmation, rather
							than the picker's muted/empty "Select model" reading.
						-->
						<span
							data-testid="gh-projects-default-model-active"
							class="inline-flex items-center gap-1 rounded-full border border-[var(--color-accent)] bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]"
						>
							<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
							</svg>
							Instance default
						</span>
					{/if}
				</div>
				<p class="mt-1 text-xs text-[var(--color-text-muted)]">
					When set, every run spawned by a card move uses this model. Leave on the
					instance default to follow your provider preference order.
				</p>
			</div>

			<div class="mt-4 flex items-center gap-3">
				<button
					type="button"
					onclick={saveMap}
					disabled={savingMap}
					data-testid="gh-projects-save-map"
					class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
				>
					{savingMap ? "Saving…" : "Save mapping"}
				</button>
				{#if mapFlash}
					<span class="text-sm text-green-400" data-testid="gh-projects-map-saved">Saved ✓</span>
				{/if}
			</div>
		</section>
	{:else}
		<!-- ── Connect form (not yet linked) ───────────────────────────── -->
		<section
			class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6"
			data-testid="gh-projects-connect-form"
		>
			<h2 class="text-lg font-semibold text-[var(--color-text-primary)]">Connect a board</h2>

			<label class="mt-4 block text-sm text-[var(--color-text-secondary)]">
				Board URL
				<input
					type="url"
					bind:value={boardUrl}
					placeholder="https://github.com/orgs/acme/projects/7"
					data-testid="gh-projects-board-url"
					class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
				/>
			</label>

			<fieldset class="mt-4">
				<legend class="text-sm text-[var(--color-text-secondary)]">Authentication</legend>
				<label class="mt-1 flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
					<input type="radio" name="authMode" value="pat" bind:group={authMode} data-testid="gh-projects-auth-pat" />
					Fine-grained Personal Access Token <span class="text-xs text-green-400">(recommended)</span>
				</label>
				<label class="mt-1 flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
					<input type="radio" name="authMode" value="gh" bind:group={authMode} data-testid="gh-projects-auth-gh" />
					Use the host's <code>gh</code> CLI identity
				</label>
			</fieldset>

			{#if authMode === "pat"}
				<label class="mt-3 block text-sm text-[var(--color-text-secondary)]">
					Token
					<input
						type="password"
						bind:value={token}
						autocomplete="off"
						placeholder="github_pat_…"
						data-testid="gh-projects-token"
						class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
					/>
				</label>
				<p class="mt-1 text-xs text-amber-400" data-testid="gh-projects-pat-warning">
					⚠ A classic PAT is org-wide — prefer a <strong>fine-grained</strong> PAT scoped to
					only this board's repositories/project.
				</p>
			{:else}
				<p class="mt-3 text-xs text-amber-400" data-testid="gh-projects-gh-warning">
					⚠ The <code>gh</code> CLI is a single global identity shared by the whole host —
					every project using it acts as the same GitHub user. Prefer a fine-grained PAT
					for per-project isolation.
				</p>
			{/if}

			{#if connectError}
				<p class="mt-3 text-sm text-red-400" data-testid="gh-projects-connect-error">{connectError}</p>
			{/if}
			{#if missingScopes.length}
				<p class="mt-1 text-sm text-red-300" data-testid="gh-projects-missing-scopes">
					Missing scopes: {missingScopes.join(", ")}
				</p>
			{/if}

			<button
				type="button"
				onclick={connect}
				disabled={connecting}
				data-testid="gh-projects-connect"
				class="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
			>
				{connecting ? "Connecting…" : "Connect board"}
			</button>
		</section>
	{/if}
</div>
