<script lang="ts">
	import { page } from "$app/state";
	import { store, setActiveProjectId } from "$lib/stores.svelte.js";
	import ModelSelector from "$lib/components/ModelSelector.svelte";
	import {
		PERMISSION_MODES,
		modeToLabel,
		modeToDescription,
		DEFAULT_PERMISSION_MODE,
	} from "$lib/permission-mode";

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
		doneStatusOptionId?: string;
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
		defaultPermissionMode: string | null;
		authMode: "pat" | "gh";
		// True when this board carries its OWN token (not the shared project one).
		hasTokenOverride: boolean;
		columnActionMap: Record<string, ColumnAction>;
		pollIntervalSec: number;
		enabled: boolean;
		lastError: string | null;
	};

	// ── Component state ────────────────────────────────────────────────────
	// A project connects to MANY boards; we render one collapsible card per
	// board. The per-card EDIT state (expanded flag, working column map, model,
	// save/refresh flashes, replace-token buffer) is kept in records keyed by
	// link id so the single inlined card snippet stays self-contained (no new
	// gated $lib component).
	let loading = $state(true);
	let links = $state<Link[]>([]);

	let expanded = $state<Record<string, boolean>>({});
	let columnMaps = $state<Record<string, Record<string, ColumnAction>>>({});
	let defaultModels = $state<Record<string, string>>({});
	// Per-board default permission mode, hydrated from the link's stored value or
	// DEFAULT_PERMISSION_MODE ("yolo") when unset (the spawn bridge's fallback).
	let defaultPermissionModes = $state<Record<string, string>>({});
	let savingMap = $state<Record<string, boolean>>({});
	let mapFlash = $state<Record<string, boolean>>({});
	let pausing = $state<Record<string, boolean>>({});
	let disconnecting = $state<Record<string, boolean>>({});
	let refreshing = $state<Record<string, boolean>>({});
	let refreshError = $state<Record<string, string>>({});
	let replacingToken = $state<Record<string, boolean>>({});
	let replaceToken = $state<Record<string, string>>({});
	let replaceError = $state<Record<string, string>>({});
	let replacing = $state<Record<string, boolean>>({});

	// Seed the per-card working copies from a loaded link (idempotent — keeps any
	// in-flight expand flag the user already toggled).
	function seedCard(link: Link) {
		columnMaps[link.id] = { ...link.columnActionMap };
		defaultModels[link.id] = link.defaultModel ?? "";
		defaultPermissionModes[link.id] = link.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
	}

	async function loadLinks() {
		loading = true;
		try {
			const res = await fetch(
				`/api/integrations/github-projects/link?projectId=${encodeURIComponent(projectId)}`,
			);
			if (res.ok) {
				const data = (await res.json()) as { links: Link[] };
				links = data.links ?? [];
				for (const link of links) {
					seedCard(link);
					// Self-heal a legacy/empty link: when the board's columns were never
					// persisted (status_options = []) the editor would fall back to raw
					// option-ids with unmapped columns dropped. Re-fetch them host-side so
					// it renders named, complete columns. Kept inside `loading` so the user
					// never sees the id-only flash.
					if (!link.statusOptions?.length) {
						await refreshColumns(link.id);
					}
				}
			} else {
				links = [];
			}
		} catch {
			links = [];
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (projectId) loadLinks();
	});

	// Replace a single link in `links` (after a PATCH / refresh) + re-seed its
	// working copies from the server's authoritative row.
	function replaceLink(updated: Link) {
		links = links.map((l) => (l.id === updated.id ? updated : l));
		seedCard(updated);
	}

	function toggleExpanded(linkId: string) {
		expanded[linkId] = !expanded[linkId];
	}

	// Owner avatar — derived CLIENT-SIDE from ownerLogin (no backend field, no
	// server egress). GitHub serves `<login>.png`; an onerror hides a broken img.
	function avatarUrl(ownerLogin: string): string {
		return `https://github.com/${encodeURIComponent(ownerLogin)}.png?size=64`;
	}

	// ── Per-card editing (all addressed by the card's linkId) ──────────────

	async function refreshColumns(linkId: string) {
		if (refreshing[linkId]) return;
		refreshing[linkId] = true;
		refreshError[linkId] = "";
		try {
			const res = await fetch("/api/integrations/github-projects/link/refresh-columns", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId, linkId }),
			});
			if (res.ok) {
				const data = (await res.json()) as { link: Link };
				replaceLink(data.link);
			} else {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				refreshError[linkId] = data.error ?? `Refresh failed (${res.status})`;
			}
		} catch (e) {
			refreshError[linkId] = e instanceof Error ? e.message : "Refresh failed";
		} finally {
			refreshing[linkId] = false;
		}
	}

	// Columns to render in a card's editor, in priority order:
	//   1. the board options PERSISTED on the link (survive a page reload), else
	//   2. last-resort: the saved map's option-id keys (a legacy link predating
	//      persisted statusOptions — shows ids, mapped columns only).
	function editableColumns(link: Link): StatusOption[] {
		if (link.statusOptions?.length) return link.statusOptions;
		const map = columnMaps[link.id] ?? {};
		return Object.keys(map).map((id) => ({ id, name: id }));
	}

	function toggleColumnEnabled(linkId: string, optionId: string, on: boolean) {
		const map = columnMaps[linkId] ?? {};
		if (on) {
			columnMaps[linkId] = { ...map, [optionId]: map[optionId] ?? { action: "plan", autoSpawn: false } };
		} else {
			const next = { ...map };
			delete next[optionId];
			columnMaps[linkId] = next;
		}
	}

	function setColumnField<K extends keyof ColumnAction>(
		linkId: string,
		optionId: string,
		key: K,
		value: ColumnAction[K],
	) {
		const map = columnMaps[linkId] ?? {};
		const existing = map[optionId] ?? { action: "plan", autoSpawn: false };
		columnMaps[linkId] = { ...map, [optionId]: { ...existing, [key]: value } };
	}

	// <ModelSelector> works in {provider, model} terms; derive its selection from
	// the persisted string — split on the FIRST ":" to mirror the server's
	// parseDefaultModel (so "ollama:gemma4:e2b" → model "gemma4:e2b").
	function selectedModel(linkId: string): { provider: string; model: string } | null {
		const raw = (defaultModels[linkId] ?? "").trim();
		const i = raw.indexOf(":");
		if (i <= 0 || i === raw.length - 1) return null;
		return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
	}

	function anyAutoSpawn(linkId: string): boolean {
		return Object.values(columnMaps[linkId] ?? {}).some((c) => c.autoSpawn);
	}

	async function saveMap(linkId: string) {
		savingMap[linkId] = true;
		mapFlash[linkId] = false;
		try {
			const res = await fetch("/api/integrations/github-projects/link", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectId,
					linkId,
					columnActionMap: columnMaps[linkId] ?? {},
					defaultModel: defaultModels[linkId] || null,
					defaultPermissionMode: defaultPermissionModes[linkId] || null,
				}),
			});
			if (res.ok) {
				const data = (await res.json()) as { link: Link };
				replaceLink(data.link);
				mapFlash[linkId] = true;
				setTimeout(() => (mapFlash[linkId] = false), 1500);
			}
		} finally {
			savingMap[linkId] = false;
		}
	}

	async function togglePause(link: Link) {
		pausing[link.id] = true;
		try {
			const res = await fetch("/api/integrations/github-projects/link", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId, linkId: link.id, enabled: !link.enabled }),
			});
			if (res.ok) {
				const data = (await res.json()) as { link: Link };
				replaceLink(data.link);
			}
		} finally {
			pausing[link.id] = false;
		}
	}

	async function disconnect(link: Link) {
		if (!confirm("Disconnect this GitHub board? The stored token is purged and active proposals are cancelled.")) {
			return;
		}
		disconnecting[link.id] = true;
		try {
			const res = await fetch("/api/integrations/github-projects/link", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId, linkId: link.id }),
			});
			if (res.ok) {
				links = links.filter((l) => l.id !== link.id);
			}
		} finally {
			disconnecting[link.id] = false;
		}
	}

	// Replace-token (pat boards). Re-runs the connect flow with this board's URL
	// + a NEW token at the board scope, overwriting the stored credential
	// host-side. The stored token is never sent to the client.
	function startReplaceToken(linkId: string) {
		replaceToken[linkId] = "";
		replaceError[linkId] = "";
		replacingToken[linkId] = true;
	}
	function cancelReplaceToken(linkId: string) {
		replacingToken[linkId] = false;
		replaceToken[linkId] = "";
		replaceError[linkId] = "";
	}
	async function submitReplaceToken(link: Link) {
		const token = replaceToken[link.id] ?? "";
		if (!token.trim()) {
			replaceError[link.id] = "Paste a new fine-grained PAT first.";
			return;
		}
		replacing[link.id] = true;
		replaceError[link.id] = "";
		try {
			const res = await fetch("/api/integrations/github-projects/connect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectId,
					boardUrl: link.boardUrl,
					authMode: "pat",
					token,
					// A replaced token always overrides only THIS board.
					tokenScope: "board",
				}),
			});
			if (res.ok) {
				replacingToken[link.id] = false;
				replaceToken[link.id] = "";
				await loadLinks();
			} else {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				replaceError[link.id] = data.error ?? `Replace failed (${res.status})`;
			}
		} catch (e) {
			replaceError[link.id] = e instanceof Error ? e.message : "Replace failed";
		} finally {
			replacing[link.id] = false;
		}
	}

	// ── "Connect another board" form ───────────────────────────────────────
	let boardUrl = $state("");
	let authMode = $state<"pat" | "gh">("pat");
	let token = $state("");
	let useBoardToken = $state(false);
	let connecting = $state(false);
	let connectError = $state("");
	let missingScopes = $state<string[]>([]);
	let grantedScopes = $state<string[]>([]);

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
					// Token is OPTIONAL for pat: omitting it reuses the shared project
					// token (a 2nd board). When provided + the override box is checked,
					// it's stored as a per-board override; otherwise it (re)sets the
					// shared token.
					token: authMode === "pat" && token ? token : undefined,
					tokenScope: useBoardToken ? "board" : "shared",
				}),
			});
			const data = (await res.json().catch(() => ({}))) as {
				error?: string;
				missingScopes?: string[];
				scopes?: string[];
			};
			if (!res.ok) {
				connectError = data.error ?? `Connect failed (${res.status})`;
				missingScopes = data.missingScopes ?? [];
				return;
			}
			grantedScopes = data.scopes ?? [];
			token = ""; // never keep the PAT in memory longer than the request
			boardUrl = "";
			useBoardToken = false;
			await loadLinks();
		} catch (e) {
			connectError = e instanceof Error ? e.message : "Connect failed";
		} finally {
			connecting = false;
		}
	}
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
			Connect one or more GitHub Projects boards to this project. Moving a card into a
			mapped column proposes (or, if you opt in, auto-spawns) an AI agent run.
		</p>
	</header>

	{#if loading}
		<p class="text-[var(--color-text-muted)]" data-testid="gh-projects-loading">Loading…</p>
	{:else}
		<!-- ── One collapsible card per connected board ─────────────────── -->
		{#each links as link (link.id)}
			{@render boardCard(link)}
		{/each}

		<!-- ── Connect another board ────────────────────────────────────── -->
		{@render connectForm()}
	{/if}
</div>

{#snippet boardCard(link: Link)}
	<section
		class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]"
		data-testid={`gh-projects-connected-${link.id}`}
	>
		<!-- ── Collapsed header: summary + owner avatar + expand toggle ── -->
		<div class="flex items-start gap-3 p-5">
			<button
				type="button"
				onclick={() => toggleExpanded(link.id)}
				data-testid={`gh-projects-card-toggle-${link.id}`}
				aria-expanded={!!expanded[link.id]}
				class="flex flex-1 items-start gap-3 text-left"
			>
				<span class="mt-0.5 text-[var(--color-text-muted)]" aria-hidden="true">
					{expanded[link.id] ? "▾" : "▸"}
				</span>
				<span class="min-w-0 flex-1">
					<span class="block text-lg font-semibold text-green-400" data-testid={`gh-projects-connected-banner-${link.id}`}>
						Connected: {link.boardTitle} ✓
					</span>
					<span class="mt-0.5 block text-xs text-[var(--color-text-secondary)]">
						{link.ownerLogin} · {link.authMode === "pat" ? "fine-grained PAT" : "gh CLI identity"}
						· {link.hasTokenOverride ? "board override" : "shared token"}
						· {Object.keys(link.columnActionMap).length} mapped
						{#if link.defaultModel}
							· model {link.defaultModel}
						{:else}
							· instance default
						{/if}
						{#if !link.enabled}
							· <span class="text-amber-400" data-testid={`gh-projects-paused-tag-${link.id}`}>paused</span>
						{:else}
							· <span class="text-green-400">healthy</span>
						{/if}
					</span>
					{#if link.lastError}
						<span class="mt-0.5 block text-xs text-red-400" data-testid={`gh-projects-health-error-${link.id}`}>
							Last error: {link.lastError}
						</span>
					{/if}
				</span>
			</button>
			<!--
				Owner avatar (top-right). Derived client-side from ownerLogin —
				GitHub serves `<login>.png`. onerror hides a broken image so a
				deleted/renamed owner never shows a broken-image glyph.
			-->
			<img
				src={avatarUrl(link.ownerLogin)}
				alt={`${link.ownerLogin} avatar`}
				data-testid={`gh-projects-avatar-${link.id}`}
				onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
				class="h-10 w-10 shrink-0 rounded-full border border-[var(--color-border)]"
			/>
		</div>

		{#if expanded[link.id]}
			<div class="space-y-5 border-t border-[var(--color-border)] p-5" data-testid={`gh-projects-card-body-${link.id}`}>
				<!-- Pause/resume + token + disconnect controls -->
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="min-w-0">
						{#if link.authMode === "pat"}
							<p class="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]" data-testid={`gh-projects-token-masked-${link.id}`}>
								<span class="font-mono tracking-widest text-[var(--color-text-muted)]">••••••••</span>
								<span>{link.hasTokenOverride ? "board token saved" : "shared token"}</span>
								{#if !replacingToken[link.id]}
									<button
										type="button"
										onclick={() => startReplaceToken(link.id)}
										data-testid={`gh-projects-replace-token-${link.id}`}
										class="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)]"
									>
										Replace token
									</button>
								{/if}
							</p>
						{/if}
					</div>
					<div class="flex shrink-0 gap-2">
						<button
							type="button"
							onclick={() => togglePause(link)}
							disabled={pausing[link.id]}
							data-testid={`gh-projects-pause-${link.id}`}
							class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
						>
							{pausing[link.id] ? "…" : link.enabled ? "Pause polling" : "Resume polling"}
						</button>
						<button
							type="button"
							onclick={() => disconnect(link)}
							disabled={disconnecting[link.id]}
							data-testid={`gh-projects-disconnect-${link.id}`}
							class="rounded-md px-3 py-1.5 text-sm text-red-400 hover:bg-[var(--color-surface-tertiary)] hover:text-red-300 disabled:opacity-50"
						>
							{disconnecting[link.id] ? "…" : "Disconnect"}
						</button>
					</div>
				</div>

				{#if replacingToken[link.id]}
					<div class="border-t border-[var(--color-border)] pt-4" data-testid={`gh-projects-replace-form-${link.id}`}>
						<label class="block text-sm text-[var(--color-text-secondary)]">
							New token (stored as a per-board override)
							<input
								type="password"
								bind:value={replaceToken[link.id]}
								autocomplete="off"
								placeholder="github_pat_…"
								data-testid={`gh-projects-replace-input-${link.id}`}
								class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
							/>
						</label>
						{#if replaceError[link.id]}
							<p class="mt-2 text-sm text-red-400" data-testid={`gh-projects-replace-error-${link.id}`}>{replaceError[link.id]}</p>
						{/if}
						<div class="mt-3 flex gap-2">
							<button
								type="button"
								onclick={() => submitReplaceToken(link)}
								disabled={replacing[link.id]}
								data-testid={`gh-projects-replace-submit-${link.id}`}
								class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
							>
								{replacing[link.id] ? "Saving…" : "Save new token"}
							</button>
							<button
								type="button"
								onclick={() => cancelReplaceToken(link.id)}
								disabled={replacing[link.id]}
								data-testid={`gh-projects-replace-cancel-${link.id}`}
								class="rounded-md px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
							>
								Cancel
							</button>
						</div>
					</div>
				{/if}

				<!-- ── Column → action mapping editor ──────────────────────── -->
				<div class="border-t border-[var(--color-border)] pt-4" data-testid={`gh-projects-column-editor-${link.id}`}>
					<div class="flex items-start justify-between gap-3">
						<h2 class="text-lg font-semibold text-[var(--color-text-primary)]">Column → action mapping</h2>
						<button
							type="button"
							onclick={() => refreshColumns(link.id)}
							disabled={refreshing[link.id]}
							data-testid={`gh-projects-refresh-columns-${link.id}`}
							title="Re-fetch this board's columns from GitHub"
							class="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
						>
							{refreshing[link.id] ? "Refreshing…" : "Refresh columns"}
						</button>
					</div>
					<p class="mt-1 mb-4 text-sm text-[var(--color-text-secondary)]">
						When a card moves into a mapped column, EZCorp spawns an AI agent that can
						run tools. Auto-spawn is <strong>off by default</strong> — a card move creates
						a proposal you approve on the Hub.
					</p>

					{#if refreshError[link.id]}
						<p class="mb-4 text-sm text-red-400" data-testid={`gh-projects-refresh-error-${link.id}`}>{refreshError[link.id]}</p>
					{/if}

					{#if anyAutoSpawn(link.id)}
						<p
							class="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
							data-testid={`gh-projects-autospawn-warning-${link.id}`}
						>
							⚠ Auto-spawn is enabled on one or more columns. A card moving there will
							launch a tool-running agent with <strong>no human approval step</strong>.
						</p>
					{/if}

					<div class="space-y-3">
						{#each editableColumns(link) as col (col.id)}
							{@const mapped = (columnMaps[link.id] ?? {})[col.id]}
							<div class="rounded-md border border-[var(--color-border)] p-3" data-testid={`gh-projects-column-row-${link.id}`}>
								<label class="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
									<input
										type="checkbox"
										checked={!!mapped}
										onchange={(e) => toggleColumnEnabled(link.id, col.id, e.currentTarget.checked)}
										data-testid={`gh-projects-column-enable-${link.id}-${col.id}`}
									/>
									<span class="font-medium">{col.name}</span>
								</label>
								{#if mapped}
									<div class="mt-2 flex flex-wrap items-center gap-4 pl-6">
										<label class="text-xs text-[var(--color-text-secondary)]">
											Action
											<select
												value={mapped.action}
												onchange={(e) => setColumnField(link.id, col.id, "action", e.currentTarget.value as "plan" | "execute")}
												data-testid={`gh-projects-column-action-${link.id}-${col.id}`}
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
												onchange={(e) => setColumnField(link.id, col.id, "autoSpawn", e.currentTarget.checked)}
												data-testid={`gh-projects-column-autospawn-${link.id}-${col.id}`}
											/>
											Auto-spawn (no approval)
										</label>
										<label class="text-xs text-[var(--color-text-secondary)]">
											On completion, move card to
											<select
												value={mapped.doneStatusOptionId ?? ""}
												onchange={(e) => setColumnField(link.id, col.id, "doneStatusOptionId", e.currentTarget.value || undefined)}
												data-testid={`gh-done-status-select-${link.id}-${col.id}`}
												class="ml-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
											>
												<option value="">— Don't move —</option>
												{#each editableColumns(link) as opt (opt.id)}
													<option value={opt.id}>{opt.name}</option>
												{/each}
											</select>
										</label>
									</div>
								{/if}
							</div>
						{/each}
						{#if editableColumns(link).length === 0}
							<p class="text-sm text-[var(--color-text-muted)]">
								Refresh columns to load this board's columns.
							</p>
						{/if}
					</div>

					<!-- ── Default model for spawned runs ──────────────────────── -->
					<div class="mt-6 border-t border-[var(--color-border)] pt-4">
						<span class="block text-sm text-[var(--color-text-secondary)]">Default model for spawned runs</span>
						<div class="mt-2 flex flex-wrap items-center gap-3" data-testid={`gh-projects-default-model-${link.id}`}>
							<ModelSelector
								selected={selectedModel(link.id)}
								onselect={(provider, model) => {
									defaultModels[link.id] = `${provider}:${model}`;
								}}
							/>
							{#if defaultModels[link.id]}
								<button
									type="button"
									onclick={() => {
										defaultModels[link.id] = "";
									}}
									data-testid={`gh-projects-default-model-clear-${link.id}`}
									class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
								>
									Use instance default
								</button>
							{:else}
								<span
									data-testid={`gh-projects-default-model-active-${link.id}`}
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
							When set, every run spawned by a card move on this board uses this model.
						</p>
					</div>

					<!-- ── Default permission mode for spawned runs ─────────────── -->
					<div class="mt-6 border-t border-[var(--color-border)] pt-4">
						<span class="block text-sm text-[var(--color-text-secondary)]">Default permission mode</span>
						<div class="mt-2 flex flex-wrap items-center gap-3">
							<select
								data-testid={`gh-projects-default-permission-mode-${link.id}`}
								bind:value={defaultPermissionModes[link.id]}
								class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
							>
								{#each PERMISSION_MODES as mode (mode)}
									<option value={mode} title={modeToDescription(mode)}>{modeToLabel(mode)}</option>
								{/each}
							</select>
							<span
								data-testid={`gh-projects-default-permission-mode-active-${link.id}`}
								class="text-xs text-[var(--color-text-muted)]"
							>
								{modeToDescription((defaultPermissionModes[link.id] ?? DEFAULT_PERMISSION_MODE) as (typeof PERMISSION_MODES)[number])}
							</span>
						</div>
						<p class="mt-1 text-xs text-[var(--color-text-muted)]">
							Every run spawned by a card move on this board uses this mode (default: YOLO — auto-approve everything).
						</p>
					</div>

					<div class="mt-4 flex items-center gap-3">
						<button
							type="button"
							onclick={() => saveMap(link.id)}
							disabled={savingMap[link.id]}
							data-testid={`gh-projects-save-map-${link.id}`}
							class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
						>
							{savingMap[link.id] ? "Saving…" : "Save mapping"}
						</button>
						{#if mapFlash[link.id]}
							<span class="text-sm text-green-400" data-testid={`gh-projects-map-saved-${link.id}`}>Saved ✓</span>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</section>
{/snippet}

{#snippet connectForm()}
	<section
		class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6"
		data-testid="gh-projects-connect-form"
	>
		<h2 class="text-lg font-semibold text-[var(--color-text-primary)]">
			{links.length ? "Connect another board" : "Connect a board"}
		</h2>

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
				Token <span class="text-xs text-[var(--color-text-muted)]">(optional — leave blank to reuse this project's saved token)</span>
				<input
					type="password"
					bind:value={token}
					autocomplete="off"
					placeholder="github_pat_…"
					data-testid="gh-projects-token"
					class="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
				/>
			</label>
			<label class="mt-2 flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
				<input
					type="checkbox"
					bind:checked={useBoardToken}
					data-testid="gh-projects-token-scope-board"
				/>
				Use a token only for this board (override the shared account token)
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
			{connecting ? "Connecting…" : links.length ? "Connect another board" : "Connect board"}
		</button>
	</section>
{/snippet}
