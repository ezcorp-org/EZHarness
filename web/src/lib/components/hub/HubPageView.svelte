<!--
  HubPageView — the full Hub page experience (tab bar + declarative tree
  render + host-rendered confirm/prompt dialogs + SSE live-invalidation),
  factored out so it can back BOTH hub routes:
    - the global "home" hub  → `/hub/[pageId]`        (hubBase="/hub")
    - the project hub        → `/project/[id]/hub/[pageId]`
                               (hubBase="/project/<id>/hub")

  The ONLY route-specific input is `hubBase`, which prefixes the tab-bar
  links so navigation stays within the route the user entered from. The
  page-render and action API calls (`/api/hub/...`) are global and never
  project-scoped.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import HubComponentRenderer from "$lib/components/hub/HubComponentRenderer.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import LucideIcon from "$lib/components/LucideIcon.svelte";
	import { formatComponentMap, getFormatComponent } from "$lib/components/ui/format-map";
	import { addToast } from "$lib/toast.svelte.js";
	import {
		parseHubPageId,
		buildActionRequest,
		type HubPageListing,
		type HubPageTree,
		type PageAction,
	} from "$lib/hub";

	// `pageId` is the active tab; `hubBase` is the route prefix the tab
	// links use (e.g. "/hub" or "/project/<id>/hub"); `projectId` (project
	// routes only) scopes every render pull so `perProject` pages get
	// project context — inert for pages without the manifest flag.
	let {
		pageId,
		hubBase,
		projectId,
	}: { pageId: string; hubBase: string; projectId?: string } = $props();

	// ── Tab list (loaded once) ───────────────────────────────────────
	let tabs = $state<HubPageListing[]>([]);
	let tabsLoaded = $state(false);

	// ── Active page state ────────────────────────────────────────────
	let tree = $state<HubPageTree | null>(null);
	let loading = $state(true);
	let stale = $state(false);
	let errorMsg = $state("");
	let actionPending = $state(false);

	// Host-rendered confirm dialog (never extension content beyond the
	// validated, truncated `confirm` string).
	let confirmAction = $state<PageAction | null>(null);

	// Host-rendered prompt dialog. The input widget is 100% host-owned;
	// the extension/provider supplies only the validated, <>-stripped,
	// truncated `action.prompt` display strings. The typed value is
	// merged client-side into payload[field] before dispatch — `prompt`
	// grants the page ZERO new dispatch authority.
	let promptAction = $state<PageAction | null>(null);
	let promptValue = $state("");

	async function loadTabs() {
		try {
			const res = await fetch("/api/hub/pages");
			if (res.ok) {
				const data = (await res.json()) as { pages: HubPageListing[] };
				tabs = data.pages;
			}
		} catch {
			// Tab bar degrades to just the active page; the render call
			// below surfaces real errors.
		} finally {
			tabsLoaded = true;
		}
	}

	// Fetch-race guard: rapid tab switches can resolve an EARLIER (slow)
	// render response after a LATER one — only the newest request may
	// write state. Monotonic token captured per call, compared on every
	// write-back.
	let loadSeq = 0;

	async function loadPage(id: string) {
		const seq = ++loadSeq;
		loading = true;
		errorMsg = "";
		try {
			const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
			const res = await fetch(`/api/hub/pages/${encodeURIComponent(id)}${query}`);
			if (seq !== loadSeq) return; // superseded by a newer load
			if (res.status === 404) {
				tree = null;
				errorMsg = "This page doesn't exist (the extension may be disabled).";
				return;
			}
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				if (seq !== loadSeq) return;
				tree = null;
				errorMsg = body?.error ?? `Failed to load (HTTP ${res.status})`;
				return;
			}
			const data = (await res.json()) as {
				page?: HubPageTree;
				error?: string;
				stale?: boolean;
			};
			if (seq !== loadSeq) return;
			if (data.error !== undefined || !data.page) {
				tree = null;
				errorMsg = data.error ?? "This page failed to render.";
				return;
			}
			tree = data.page;
			stale = data.stale === true;
		} catch (e) {
			if (seq !== loadSeq) return;
			tree = null;
			errorMsg = e instanceof Error ? e.message : "Failed to load page";
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	function requestAction(action: PageAction) {
		// Precedence: prompt → confirm → dispatch. When BOTH prompt and
		// confirm are set, the confirm text shows as the prompt dialog body.
		if (action.prompt) {
			promptAction = action;
			promptValue = "";
			return;
		}
		if (action.confirm) {
			confirmAction = action;
			return;
		}
		void dispatchAction(action);
	}

	function submitPrompt() {
		const action = promptAction;
		if (!action?.prompt) return;
		const value = promptValue.trim();
		if (value.length === 0) return; // Submit is disabled, but guard anyway
		const field = action.prompt.field ?? "value";
		const merged: PageAction = {
			...action,
			payload: { ...action.payload, [field]: value },
		};
		promptAction = null;
		promptValue = "";
		void dispatchAction(merged);
	}

	function cancelPrompt() {
		promptAction = null;
		promptValue = "";
	}

	async function dispatchAction(action: PageAction) {
		const parsed = parseHubPageId(pageId);
		if (!parsed) return;
		const request = buildActionRequest(parsed, action);
		if (!request) return;
		actionPending = true;
		try {
			const res = await fetch(request.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request.body),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				addToast({ type: "error", message: body?.error ?? `Action failed (HTTP ${res.status})` });
				return;
			}
			const data = (await res.json().catch(() => null)) as
				| { page?: HubPageTree; ok?: boolean; message?: string }
				| null;
			// In-process extension actions report a DOMAIN refusal as HTTP 200
			// with `{ok:false, message}` (e.g. an unreachable folder path, or a
			// duplicate). Without this the message is dropped and the action
			// "silently does nothing" — surface it as an error toast instead.
			if (data && data.ok === false) {
				addToast({ type: "error", message: data.message ?? "That action couldn't be completed" });
				return;
			}
			if (data?.page) {
				// Core actions may return a fresh validated tree inline.
				tree = data.page;
				stale = false;
			} else {
				// Extension actions (and tree-less core actions): re-pull.
				await loadPage(pageId);
			}
		} catch (e) {
			addToast({ type: "error", message: e instanceof Error ? e.message : "Action failed" });
		} finally {
			actionPending = false;
		}
	}

	onMount(() => {
		void loadTabs();

		// Live invalidation (Phase 2): the global SSE subscriber
		// re-dispatches `ext:page-state` as a window CustomEvent carrying
		// ONLY {extensionName, pageId} — never tree content. If it names
		// the page we're looking at, re-pull the render endpoint.
		function onPageState(e: Event) {
			const detail = (e as CustomEvent).detail as
				| { extensionName?: string; pageId?: string }
				| undefined;
			if (!detail?.extensionName || !detail?.pageId) return;
			if (pageId === `ext:${detail.extensionName}:${detail.pageId}`) {
				void loadPage(pageId);
			}
		}
		window.addEventListener("ext:page-state", onPageState);
		return () => window.removeEventListener("ext:page-state", onPageState);
	});

	// Re-load whenever the route param changes (tab click / deep link).
	$effect(() => {
		if (pageId) void loadPage(pageId);
	});

	let activeTab = $derived(tabs.find((t) => t.id === pageId));
</script>

<svelte:head>
	<title>{activeTab?.title ?? "Hub"} - EZCorp</title>
</svelte:head>

<div class="mx-auto max-w-4xl space-y-4">
	<!-- Tab bar -->
	{#if tabsLoaded && tabs.length > 0}
		<div class="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] pb-0" role="tablist" aria-label="Hub pages">
			{#each tabs as tab}
				{@const active = tab.id === pageId}
				<a
					href={`${hubBase}/${encodeURIComponent(tab.id)}`}
					role="tab"
					aria-selected={active}
					data-testid="hub-tab"
					class="flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors {active
						? 'border-[var(--color-accent)] text-[var(--color-text-primary)]'
						: 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
				>
					{#if tab.icon}
						<LucideIcon name={tab.icon} size={14} class="shrink-0" />
					{/if}
					{tab.title}
				</a>
			{/each}
		</div>
	{/if}

	<!-- Page body -->
	{#if loading}
		<SkeletonLoader type="lines" lines={6} statusText="Loading page…" />
	{:else if errorMsg}
		<div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4" data-testid="hub-error-card">
			<div class="text-sm font-medium text-red-300">Couldn't load this page</div>
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">{errorMsg}</p>
			<button
				type="button"
				class="mt-3 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
				data-testid="hub-retry-btn"
				onclick={() => loadPage(pageId)}
			>
				Retry
			</button>
		</div>
	{:else if tree}
		<div class="flex items-center justify-between gap-2">
			<h1 class="min-w-0 break-words text-xl font-bold text-[var(--color-text-primary)] [overflow-wrap:anywhere]" data-testid="hub-page-title">{tree.title}</h1>
			<div class="flex shrink-0 items-center gap-2">
				{#if stale}
					<span class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]" data-testid="hub-stale-indicator">refreshing…</span>
				{/if}
				<button
					type="button"
					class="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
					data-testid="hub-refresh-btn"
					disabled={actionPending}
					onclick={() => loadPage(pageId)}
				>
					Refresh
				</button>
			</div>
		</div>
		<div class="space-y-4" data-testid="hub-page-body">
			<HubComponentRenderer nodes={tree.nodes} onAction={requestAction} />
		</div>
	{/if}
</div>

<!-- Host-rendered prompt dialog (sibling of the confirm dialog). The
     input is host-owned; only the validated prompt display strings come
     from the page tree. -->
{#if promptAction?.prompt}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="hub-prompt-dialog">
		<div class="w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-5 shadow-xl">
			<label class="block text-sm font-semibold text-[var(--color-text-primary)]" for="hub-prompt-input">
				{promptAction.prompt.label}
			</label>
			{#if promptAction.confirm}
				<p class="mt-1 text-xs text-[var(--color-text-muted)]">{promptAction.confirm}</p>
			{/if}
			{#if promptAction.prompt.format && promptAction.prompt.format in formatComponentMap}
				<!-- DRY: reuse the app's shared format widget (e.g. the
				     filesystem picker for `file-path`) instead of a bespoke
				     input. The widget owns its own keyboard handling
				     (Enter/Esc drive its dropdown), so the host doesn't
				     attach Enter-submit here — the user clicks Submit. -->
				{@const PromptWidget = getFormatComponent(promptAction.prompt.format)}
				<div class="mt-3" data-testid="hub-prompt-format">
					<!-- The Hub file-path picker browses the HOST filesystem and
					     its consumers (e.g. file-organizer's `normalizeFolderPath`)
					     require an absolute path. Opt the picker into absolute
					     mode so browse/select/typed-name all yield `/…` values —
					     never a `~`-relative one. The flag is inert for the other
					     format widgets, which don't browse the filesystem. -->
					<PromptWidget
						bind:value={promptValue}
						size="md"
						absolute={promptAction.prompt.format === "file-path"}
						placeholder={promptAction.prompt.placeholder ?? ""}
					/>
				</div>
			{:else}
				<input
					id="hub-prompt-input"
					type="text"
					class="mt-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
					data-testid="hub-prompt-input"
					bind:value={promptValue}
					placeholder={promptAction.prompt.placeholder ?? ""}
					maxlength={promptAction.prompt.maxLength ?? 200}
					autocomplete="off"
					onkeydown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							submitPrompt();
						} else if (e.key === "Escape") {
							e.preventDefault();
							cancelPrompt();
						}
					}}
				/>
			{/if}
			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
					data-testid="hub-prompt-cancel"
					onclick={cancelPrompt}
				>
					Cancel
				</button>
				<button
					type="button"
					class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					data-testid="hub-prompt-submit"
					disabled={promptValue.trim().length === 0}
					onclick={submitPrompt}
				>
					{promptAction.prompt.submitLabel ?? "Submit"}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Host-rendered confirm dialog -->
{#if confirmAction}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="hub-confirm-dialog">
		<div class="w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-5 shadow-xl">
			<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">Are you sure?</h2>
			<p class="mt-2 text-sm text-[var(--color-text-secondary)]">{confirmAction.confirm}</p>
			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
					data-testid="hub-confirm-cancel"
					onclick={() => (confirmAction = null)}
				>
					Cancel
				</button>
				<button
					type="button"
					class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] hover:opacity-90"
					data-testid="hub-confirm-ok"
					onclick={() => {
						const action = confirmAction;
						confirmAction = null;
						if (action) void dispatchAction(action);
					}}
				>
					Confirm
				</button>
			</div>
		</div>
	</div>
{/if}
