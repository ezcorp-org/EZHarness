<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import HubComponentRenderer from "$lib/components/hub/HubComponentRenderer.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import LucideIcon from "$lib/components/LucideIcon.svelte";
	import { addToast } from "$lib/toast.svelte.js";
	import {
		parseHubPageId,
		buildActionRequest,
		type HubPageListing,
		type HubPageTree,
		type PageAction,
	} from "$lib/hub";

	// ── Tab list (loaded once) ───────────────────────────────────────
	let tabs = $state<HubPageListing[]>([]);
	let tabsLoaded = $state(false);

	// ── Active page state ────────────────────────────────────────────
	let pageId = $derived(page.params.pageId ?? "");
	let tree = $state<HubPageTree | null>(null);
	let loading = $state(true);
	let stale = $state(false);
	let errorMsg = $state("");
	let actionPending = $state(false);

	// Host-rendered confirm dialog (never extension content beyond the
	// validated, truncated `confirm` string).
	let confirmAction = $state<PageAction | null>(null);

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

	async function loadPage(id: string) {
		loading = true;
		errorMsg = "";
		try {
			const res = await fetch(`/api/hub/pages/${encodeURIComponent(id)}`);
			if (res.status === 404) {
				tree = null;
				errorMsg = "This page doesn't exist (the extension may be disabled).";
				return;
			}
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				tree = null;
				errorMsg = body?.error ?? `Failed to load (HTTP ${res.status})`;
				return;
			}
			const data = (await res.json()) as {
				page?: HubPageTree;
				error?: string;
				stale?: boolean;
			};
			if (data.error !== undefined || !data.page) {
				tree = null;
				errorMsg = data.error ?? "This page failed to render.";
				return;
			}
			tree = data.page;
			stale = data.stale === true;
		} catch (e) {
			tree = null;
			errorMsg = e instanceof Error ? e.message : "Failed to load page";
		} finally {
			loading = false;
		}
	}

	function requestAction(action: PageAction) {
		if (action.confirm) {
			confirmAction = action;
			return;
		}
		void dispatchAction(action);
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
				| { page?: HubPageTree }
				| null;
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
					href={`/hub/${encodeURIComponent(tab.id)}`}
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
			<h1 class="text-xl font-bold text-[var(--color-text-primary)]" data-testid="hub-page-title">{tree.title}</h1>
			<div class="flex items-center gap-2">
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
					class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
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
