<script lang="ts">
	/**
	 * Code review panel — a clone of GitHub's pull-request "Files changed" tab.
	 *
	 * Layout, top to bottom / left to right:
	 *   • sticky toolbar — "Files changed" + count, `+N −M` with the five-square
	 *     diffstat, the "Filter changed files" box, the Split/Unified segmented
	 *     control, Expand/Collapse all, and the `x / y files viewed` progress;
	 *   • left rail — the collapsible file tree, which jumps to a file;
	 *   • right column — one GitHub diff card per file (sticky header, Viewed
	 *     checkbox, copy-path).
	 *
	 * The panel occupies 75% of the viewport on desktop so a split diff has the
	 * same breathing room it does on github.com.
	 *
	 * Everything the header shows is derived by `$lib/diff-review/review-model`
	 * from the same two upstream sources the panel always had (tool-call edits
	 * and fenced ```diff blocks) — the model merges them into one file list so
	 * the review reads as a single changeset, not two lists.
	 */
	import type { Message } from "$lib/api.js";
	import type { InlineToolCall } from "$lib/inline-tool-store.svelte.js";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";
	import { extractDiffBlocks, aggregateToolCallDiffs } from "$lib/diff-aggregator.js";
	// diff2html-patched.css + hljs-theme.css + github-review.css are loaded
	// globally via app.css (Svelte-scoped imports confuse @tailwindcss/vite —
	// issue #16233).
	import { loadDiffViewMode, persistDiffViewMode, type DiffViewMode } from "$lib/diff-view-mode.js";
	import {
		allDirPaths,
		buildFileTree,
		buildReviewFiles,
		filterReviewFiles,
		isLargeDiff,
		toggleInSet,
		totalStats,
		type ReviewFile,
	} from "$lib/diff-review/review-model.js";
	import {
		loadViewedFiles,
		persistViewedFiles,
		viewedCount,
	} from "$lib/diff-review/viewed-files.js";
	import DiffStatBar from "./review/DiffStatBar.svelte";
	import ReviewFileCard from "./review/ReviewFileCard.svelte";
	import ReviewFileTree from "./review/ReviewFileTree.svelte";
	import type { PersonalPrView } from "$lib/personal-pr.js";
	import { trustedGithubPrUrl } from "$lib/personal-pr.js";

	let {
		messages = [],
		toolCalls = [],
		open = false,
		onclose,
		streaming = false,
		conversationId = "",
		personalPr = null,
		onpersonalprupdate,
	}: {
		messages: Message[];
		toolCalls: InlineToolCall[];
		open: boolean;
		onclose: () => void;
		streaming: boolean;
		conversationId?: string;
		personalPr?: PersonalPrView | null;
		onpersonalprupdate?: (view: PersonalPrView) => void;
	} = $props();

	let prTitle = $state("");
	let prBody = $state("");
	let prBusy = $state(false);
	let prError = $state("");
	let confirmationKey = $state<string | null>(null);
	let exactFilesAvailable = $derived(!!personalPr?.files?.length && personalPr.files.every((file) => file.binary ? !!(file.beforeBase64 || file.afterBase64) : typeof file.patch === "string"));
	$effect(() => {
		void personalPr?.proposalId;
		prTitle = personalPr?.title ?? "";
		prBody = personalPr?.body ?? "";
		prError = "";
		confirmationKey = null;
	});

	async function confirmPersonalPr() {
		if (!personalPr?.proposalId || !personalPr.digest || prBusy) return;
		prBusy = true;
		prError = "";
		confirmationKey ??= crypto.randomUUID();
		try {
			const response = await fetch(`/api/github/personal-prs/proposals/${encodeURIComponent(personalPr.proposalId)}/confirm`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedDigest: personalPr.digest, title: prTitle, body: prBody, idempotencyKey: confirmationKey }),
			});
			const updated = await response.json();
			if (!response.ok) throw new Error(updated.error ?? "Could not create draft PR");
			onpersonalprupdate?.(updated as PersonalPrView);
		} catch (cause) {
			prError = cause instanceof Error ? cause.message : "Could not create draft PR";
		} finally { prBusy = false; }
	}

	async function refreshPersonalPr() {
		if (!personalPr?.proposalId) return;
		prBusy = true;
		try {
			const response = await fetch(`/api/github/personal-prs/proposals/${encodeURIComponent(personalPr.proposalId)}`);
			const updated = await response.json();
			if (!response.ok) throw new Error(updated.error ?? "Could not check draft PR status");
			prError = "";
			onpersonalprupdate?.(updated as PersonalPrView);
		} catch (cause) {
			prError = cause instanceof Error ? cause.message : "Could not check draft PR status";
		} finally { prBusy = false; }
	}

	// Fenced ```diff blocks from settled assistant messages (skip the last one
	// mid-stream — a half-written hunk renders as garbage).
	let codeDiffs = $derived.by(() => {
		const msgs = streaming ? messages.slice(0, -1) : messages;
		return msgs
			.filter((m) => m.role === "assistant" && m.content)
			.flatMap((m) => extractDiffBlocks(m.content, m.id));
	});

	let fileChanges = $derived.by(() => {
		const completed = toolCalls.filter((tc) => tc.status === "complete");
		return aggregateToolCallDiffs(
			completed.map((tc) => ({ toolName: tc.toolName, input: tc.input, output: tc.output })),
		);
	});

	let files = $derived(buildReviewFiles(fileChanges, codeDiffs));
	let filter = $state("");
	let shownFiles = $derived(filterReviewFiles(files, filter));
	let totals = $derived(totalStats(shownFiles));
	let tree = $derived(buildFileTree(shownFiles));

	// Split/unified is a global personal preference — restore the last pick so a
	// refresh doesn't snap back to split. See $lib/diff-view-mode.ts.
	let diffView = $state<DiffViewMode>(loadDiffViewMode());
	// GitHub opens every file expanded EXCEPT the very large ones. Both sets
	// hold explicit user overrides of that default, so a file's open state is
	// `expandedKeys ?? !collapsed ?? !isLargeDiff`.
	let collapsed = $state<Set<string>>(new Set());
	let expandedKeys = $state<Set<string>>(new Set());
	let collapsedDirs = $state<Set<string>>(new Set());
	let treeOpen = $state(true);
	let activeKey = $state<string | null>(null);
	let viewed = $state<Set<string>>(new Set());

	// Reset the whole review whenever the conversation changes: the ticked set
	// is re-read from storage, and the transient state (filter, collapsed
	// files/dirs, tree selection) is cleared. File keys are path-based, so
	// without this a file collapsed in one chat would open collapsed in the
	// next chat that happens to touch the same path.
	$effect(() => {
		viewed = loadViewedFiles(conversationId);
		filter = "";
		collapsed = new Set();
		expandedKeys = new Set();
		collapsedDirs = new Set();
		activeKey = null;
	});

	let expandedDirs = $derived.by(() => {
		const dirs = new Set(allDirPaths(tree));
		for (const path of collapsedDirs) dirs.delete(path);
		return dirs;
	});

	let viewedShown = $derived(
		viewedCount(
			viewed,
			shownFiles.map((f) => f.key),
		),
	);
	/** A file's effective open state: explicit override, else the default. */
	function isOpen(file: ReviewFile): boolean {
		if (expandedKeys.has(file.key)) return true;
		if (collapsed.has(file.key)) return false;
		return !isLargeDiff(file);
	}

	let allCollapsed = $derived(shownFiles.length > 0 && !shownFiles.some(isOpen));

	function setDiffView(mode: DiffViewMode) {
		diffView = mode;
		persistDiffViewMode(mode);
	}

	/** Flip a file open/closed, recording the choice as an explicit override. */
	function toggleFile(file: ReviewFile) {
		const open = isOpen(file);
		const nextCollapsed = new Set(collapsed);
		const nextExpanded = new Set(expandedKeys);
		if (open) {
			nextCollapsed.add(file.key);
			nextExpanded.delete(file.key);
		} else {
			nextExpanded.add(file.key);
			nextCollapsed.delete(file.key);
		}
		collapsed = nextCollapsed;
		expandedKeys = nextExpanded;
	}

	function toggleAll() {
		// Snapshot the decision FIRST: `allCollapsed` is a $derived over the two
		// sets below, so reading it again after the first assignment would see
		// the half-applied state and undo the toggle.
		const openAll = allCollapsed;
		const keys = shownFiles.map((f) => f.key);
		collapsed = openAll ? new Set() : new Set(keys);
		expandedKeys = openAll ? new Set(keys) : new Set();
	}

	function toggleDir(path: string) {
		collapsedDirs = toggleInSet(collapsedDirs, path);
	}

	function markViewed(file: ReviewFile) {
		viewed = toggleInSet(viewed, file.key);
		persistViewedFiles(conversationId, viewed);
	}

	function jumpTo(file: ReviewFile) {
		activeKey = file.key;
		document
			.getElementById(`review-file-${file.key}`)
			?.scrollIntoView({ block: "start", behavior: "smooth" });
	}
</script>

<SwipeDrawer {open} side="right" width="w-full md:w-[75vw]" {onclose} ariaLabel="Files changed">
	<div
		class="gh-review flex h-full flex-col border-l border-[var(--gh-border)]"
		data-testid="diff-summary-panel"
	>
		{#if personalPr}
			<section class="min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface-secondary)] p-4" data-testid="personal-pr-review">
				<div class="flex items-start justify-between gap-4"><h3 class="text-base font-semibold text-[var(--color-text-primary)]">This run’s draft PR</h3><button class="text-sm text-[var(--color-text-secondary)]" aria-label="Close PR review" onclick={onclose}>Close</button></div>
				<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{personalPr.repository?.fullName ?? "Repository"} · base {personalPr.repository?.baseRef ?? "unknown"} · {personalPr.files?.length ?? 0} files</p>
				<p class="mt-2 text-xs text-[var(--color-text-muted)]">The file list below is the saved run snapshot used for the PR.</p>
					{#if personalPr.files?.length}
						<ul class="mt-3 max-h-32 overflow-y-auto rounded-md border border-[var(--color-border)] p-2 text-xs text-[var(--color-text-secondary)]">
							{#each personalPr.files as file}<li class="flex justify-between gap-3 py-0.5"><span class="min-w-0 truncate" title={file.path}>{file.status} · {file.path}</span><span class="shrink-0">{file.binary ? "binary" : `+${file.additions} −${file.deletions}`}</span></li>{/each}
						</ul>
						<div class="mt-3 max-h-[45vh] space-y-3 overflow-y-auto" data-testid="personal-pr-exact-diff">
							{#each personalPr.files as file}
								<article class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
									<h4 class="border-b border-[var(--color-border)] px-3 py-2 text-xs font-semibold text-[var(--color-text-primary)] break-all">{file.path}</h4>
									{#if file.binary}
										<div class="space-y-1 px-3 py-2 text-xs text-[var(--color-text-secondary)]"><p>Binary change. Review the exact bytes before confirming.</p>
											{#if file.beforeBase64}<p>Before: {file.beforeBytes ?? 0} bytes · SHA-256 {file.beforeSha256}</p><a class="text-[var(--color-accent)] underline" href={`data:application/octet-stream;base64,${file.beforeBase64}`} download={`${file.path.split("/").at(-1) ?? "file"}.before`}>Download before</a>{/if}
											{#if file.afterBase64}<p>After: {file.afterBytes ?? 0} bytes · SHA-256 {file.afterSha256}</p><a class="text-[var(--color-accent)] underline" href={`data:application/octet-stream;base64,${file.afterBase64}`} download={`${file.path.split("/").at(-1) ?? "file"}.after`}>Download after</a>{/if}
										</div>
									{:else if typeof file.patch === "string"}
										<pre class="max-h-72 overflow-auto px-3 py-2 text-xs leading-5 text-[var(--color-text-primary)]">{file.patch}</pre>
									{:else}<p class="px-3 py-2 text-xs text-red-700 dark:text-red-300">Exact diff unavailable.</p>{/if}
								</article>
							{/each}
						</div>
					{/if}
				{#if personalPr.checks?.length}<p class="mt-2 text-xs text-[var(--color-text-secondary)]">Checks: {personalPr.checks.map((check) => `${check.name}: ${check.result}`).join(" · ")}</p>{/if}
				{#if personalPr.state === "ready" || personalPr.state === "reviewing"}
					<div class="mt-3 grid gap-2">
						<label class="text-xs font-medium text-[var(--color-text-secondary)]" for="personal-pr-title">PR title</label>
						<input id="personal-pr-title" bind:value={prTitle} maxlength="256" class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]" />
						<label class="text-xs font-medium text-[var(--color-text-secondary)]" for="personal-pr-body">PR description</label>
						<textarea id="personal-pr-body" bind:value={prBody} maxlength="16384" rows="3" class="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"></textarea>
					</div>
						<div class="mt-3 flex flex-wrap items-center gap-3"><button class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={prBusy || !!prError || !prTitle.trim() || !personalPr.digest || !exactFilesAvailable} onclick={confirmPersonalPr}>Create draft PR</button><span class="text-xs text-[var(--color-text-muted)]">Nothing pushed until you confirm.</span></div>
				{:else if personalPr.state === "created" && trustedGithubPrUrl(personalPr.prUrl)}
					<a class="mt-3 inline-block text-sm text-[var(--color-accent)] underline" href={trustedGithubPrUrl(personalPr.prUrl) ?? undefined} target="_blank" rel="noopener noreferrer">Open draft PR on GitHub</a>
				{:else}<p class="mt-3 text-sm text-[var(--color-text-secondary)]" role="status">{personalPr.blockReason ?? `PR status: ${personalPr.state}`}</p>{/if}
				{#if prError}<div class="mt-2 flex items-center gap-3"><p class="text-sm text-red-700 dark:text-red-300" role="alert">{prError}</p><button class="text-sm text-[var(--color-accent)] underline" disabled={prBusy} onclick={refreshPersonalPr}>Check status</button></div>{/if}
			</section>
		{/if}
		{#if !personalPr}
		<!-- ── Toolbar ─────────────────────────────────────────────────── -->
		<header class="gh-review__toolbar" data-testid="diff-review-toolbar">
			<div class="gh-review__title-row">
				<h2 class="gh-review__title">Files changed</h2>
				<span class="gh-review__count" data-testid="diff-review-count">{totals.files}</span>
				<span class="gh-review__totals" data-testid="diff-review-totals">
					<span class="gh-review__add">+{totals.additions}</span>
					<span class="gh-review__del">−{totals.deletions}</span>
				</span>
				<DiffStatBar additions={totals.additions} deletions={totals.deletions} />

				<div class="gh-review__spacer"></div>

				<div class="gh-review__progress" data-testid="diff-viewed-progress">
					<span class="gh-review__progress-label">
						{viewedShown} / {totals.files} files viewed
					</span>
					<span class="gh-review__progress-track">
						<span
							class="gh-review__progress-fill"
							data-testid="diff-viewed-progress-fill"
							style:width="{totals.files === 0 ? 0 : (viewedShown / totals.files) * 100}%"
						></span>
					</span>
				</div>

				<button
					type="button"
					onclick={onclose}
					aria-label="Close"
					class="gh-review__icon-btn"
					data-testid="diff-panel-close"
				>
					<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
						<path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
					</svg>
				</button>
			</div>

			<div class="gh-review__controls">
				<label class="gh-review__search">
					<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<path fill="currentColor" d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-1.06 1.06ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z" />
					</svg>
					<input
						type="search"
						bind:value={filter}
						placeholder="Filter changed files"
						aria-label="Filter changed files"
						data-testid="diff-file-filter"
					/>
				</label>

				<div class="gh-review__segmented" data-testid="diff-view-toggle">
					<button
						type="button"
						class:gh-review__segmented--on={diffView === "side-by-side"}
						aria-pressed={diffView === "side-by-side"}
						onclick={() => setDiffView("side-by-side")}>Split</button
					>
					<button
						type="button"
						class:gh-review__segmented--on={diffView === "line-by-line"}
						aria-pressed={diffView === "line-by-line"}
						onclick={() => setDiffView("line-by-line")}>Unified</button
					>
				</div>

				<button
					type="button"
					class="gh-review__btn"
					data-testid="diff-toggle-all"
					onclick={toggleAll}
					disabled={shownFiles.length === 0}
				>
					{allCollapsed ? "Expand all" : "Collapse all"}
				</button>

				<!-- Last control on purpose: `createFocusTrap` focuses the panel's
				     FIRST focusable on open, and InfoTooltip pops its bubble on
				     focus — leading with it would cover the file tree every time
				     the review opened. -->
				<InfoTooltip key="chat.diff-panel" />
			</div>
		</header>

		<!-- ── Body: file tree + diff column ───────────────────────────── -->
		<div class="gh-review__body">
			{#if shownFiles.length > 0}
				{#if treeOpen}
					<aside class="gh-review__rail" data-testid="diff-file-tree">
						<div class="gh-review__rail-head">
							<span>Files</span>
							<button
								type="button"
								class="gh-review__icon-btn"
								aria-label="Hide file tree"
								data-testid="diff-tree-hide"
								onclick={() => (treeOpen = false)}
							>
								<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
									<path fill="currentColor" d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
								</svg>
							</button>
						</div>
						<div class="gh-review__rail-body">
							<ReviewFileTree
								nodes={tree}
								{expandedDirs}
								{viewed}
								{activeKey}
								ontoggledir={toggleDir}
								onselect={jumpTo}
							/>
						</div>
					</aside>
				{:else}
					<button
						type="button"
						class="gh-review__rail-show"
						aria-label="Show file tree"
						data-testid="diff-tree-show"
						onclick={() => (treeOpen = true)}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
							<path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
						</svg>
					</button>
				{/if}
			{/if}

			<main class="gh-review__files" data-testid="diff-review-files">
				{#if files.length === 0}
					<div class="gh-review__empty" data-testid="diff-panel-empty">
						<svg viewBox="0 0 16 16" width="32" height="32" aria-hidden="true">
							<path fill="currentColor" d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm8.75.75v2.5c0 .138.112.25.25.25h2.5Z" />
						</svg>
						<p>No file changes in this conversation</p>
						<span>Files edited by the assistant show up here as a reviewable diff.</span>
					</div>
				{:else if shownFiles.length === 0}
					<div class="gh-review__empty" data-testid="diff-filter-empty">
						<p>No changed files match “{filter}”</p>
						<button type="button" class="gh-review__btn" onclick={() => (filter = "")}>
							Clear filter
						</button>
					</div>
				{:else}
					{#each shownFiles as file (file.key)}
						<ReviewFileCard
							{file}
							expanded={isOpen(file)}
							viewed={viewed.has(file.key)}
							{diffView}
							ontoggle={() => toggleFile(file)}
							onviewed={() => markViewed(file)}
						/>
					{/each}
				{/if}
			</main>
			</div>
		{/if}
	</div>
</SwipeDrawer>

<style>
	/* ── Toolbar ─────────────────────────────────────────────────────── */
	.gh-review__toolbar {
		background-color: var(--gh-canvas);
		border-bottom: 1px solid var(--gh-border);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		gap: 8px;
		padding: 12px 16px;
	}
	.gh-review__title-row,
	.gh-review__controls {
		align-items: center;
		display: flex;
		gap: 8px;
	}
	.gh-review__title {
		font-size: 14px;
		font-weight: 600;
		margin: 0;
	}
	.gh-review__count {
		background-color: var(--gh-border-muted);
		border-radius: 2em;
		font-size: 12px;
		font-weight: 500;
		line-height: 18px;
		padding: 0 7px;
	}
	.gh-review__totals {
		display: inline-flex;
		font-family: var(--gh-mono);
		font-size: 12px;
		gap: 4px;
	}
	.gh-review__add {
		color: var(--gh-success-fg);
	}
	.gh-review__del {
		color: var(--gh-danger-fg);
	}
	.gh-review__spacer {
		flex: 1;
	}

	.gh-review__progress {
		align-items: center;
		display: flex;
		gap: 8px;
	}
	.gh-review__progress-label {
		color: var(--gh-fg-muted);
		font-size: 12px;
		white-space: nowrap;
	}
	.gh-review__progress-track {
		background-color: var(--gh-border-muted);
		border-radius: 3px;
		display: block;
		height: 6px;
		overflow: hidden;
		width: 80px;
	}
	.gh-review__progress-fill {
		background-color: #2da44e;
		display: block;
		height: 100%;
		transition: width 150ms ease;
	}

	.gh-review__icon-btn {
		align-items: center;
		background: none;
		border: 0;
		border-radius: 4px;
		color: var(--gh-fg-muted);
		cursor: pointer;
		display: flex;
		justify-content: center;
		padding: 4px;
	}
	.gh-review__icon-btn:hover {
		background-color: var(--gh-canvas-subtle);
		color: var(--gh-fg);
	}

	/* ── Controls row ────────────────────────────────────────────────── */
	.gh-review__search {
		align-items: center;
		background-color: var(--gh-canvas);
		border: 1px solid var(--gh-border);
		border-radius: 6px;
		color: var(--gh-fg-muted);
		display: flex;
		flex: 1;
		gap: 6px;
		max-width: 22rem;
		padding: 4px 8px;
	}
	.gh-review__search:focus-within {
		border-color: var(--gh-accent);
		box-shadow: 0 0 0 1px var(--gh-accent);
	}
	.gh-review__search input {
		background: transparent;
		border: 0;
		color: var(--gh-fg);
		flex: 1;
		font-size: 12px;
		line-height: 20px;
		min-width: 0;
		outline: none;
	}

	.gh-review__segmented {
		display: inline-flex;
	}
	.gh-review__segmented button {
		background-color: var(--gh-canvas);
		border: 1px solid var(--gh-border);
		color: var(--gh-fg);
		cursor: pointer;
		font-size: 12px;
		line-height: 20px;
		padding: 3px 12px;
	}
	.gh-review__segmented button:first-child {
		border-radius: 6px 0 0 6px;
	}
	.gh-review__segmented button:last-child {
		border-left: 0;
		border-radius: 0 6px 6px 0;
	}
	.gh-review__segmented button:hover {
		background-color: var(--gh-canvas-subtle);
	}
	.gh-review__segmented button.gh-review__segmented--on {
		background-color: var(--gh-accent);
		border-color: var(--gh-accent);
		color: #ffffff;
	}

	.gh-review__btn {
		background-color: var(--gh-canvas-subtle);
		border: 1px solid var(--gh-border);
		border-radius: 6px;
		color: var(--gh-fg);
		cursor: pointer;
		font-size: 12px;
		line-height: 20px;
		padding: 3px 12px;
		white-space: nowrap;
	}
	.gh-review__btn:hover:not(:disabled) {
		background-color: var(--gh-border-muted);
	}
	.gh-review__btn:disabled {
		cursor: default;
		opacity: 0.5;
	}

	/* ── Body ────────────────────────────────────────────────────────── */
	.gh-review__body {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.gh-review__rail {
		border-right: 1px solid var(--gh-border);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		width: 16rem;
	}
	.gh-review__rail-head {
		align-items: center;
		color: var(--gh-fg-muted);
		display: flex;
		font-size: 12px;
		font-weight: 600;
		justify-content: space-between;
		padding: 8px 8px 8px 12px;
	}
	.gh-review__rail-body {
		flex: 1;
		overflow-y: auto;
		padding: 0 8px 12px;
	}
	.gh-review__rail-show {
		align-items: flex-start;
		background: none;
		border: 0;
		border-right: 1px solid var(--gh-border);
		color: var(--gh-fg-muted);
		cursor: pointer;
		display: flex;
		padding: 12px 6px;
	}
	.gh-review__rail-show:hover {
		background-color: var(--gh-canvas-subtle);
		color: var(--gh-fg);
	}

	.gh-review__files {
		background-color: var(--gh-canvas-inset);
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		padding: 16px;
	}

	.gh-review__empty {
		align-items: center;
		color: var(--gh-fg-muted);
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 64px 16px;
		text-align: center;
	}
	.gh-review__empty svg {
		opacity: 0.4;
	}
	.gh-review__empty p {
		color: var(--gh-fg);
		font-size: 14px;
		font-weight: 600;
		margin: 0;
	}
	.gh-review__empty span {
		font-size: 12px;
	}
</style>
