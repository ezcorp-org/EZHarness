<script lang="ts">
	/**
	 * Lessons curation tab — `/memories → Lessons`.
	 *
	 * Lists every lesson visible to (projectId, currentUser): user-owned
	 * + project-shared + global (slug-deduped, most-specific wins). The
	 * server returns `ownedByMe` per row; the UI gates delete + promote
	 * affordances on that flag — a row owned by another user renders
	 * read-only.
	 *
	 * Visibility ladder is monotonic on the client too: the promote
	 * dropdown disables backward options. The server still re-validates
	 * (returns 409 on backward attempts) — this is defense in depth, not
	 * the source of truth.
	 *
	 * Delete UX matches `KnowledgeBaseTab.svelte`: inline click-to-confirm
	 * with a 3-second timeout. No native `window.confirm`.
	 */

	interface Lesson {
		id: string;
		slug: string;
		title: string;
		body: string;
		visibility: "user" | "project" | "global";
		ownedByMe: boolean;
		source: "distiller" | "user";
		firedCount: number;
		lastFiredAt: string | null;
		dismissedCount: number;
		createdAt: string;
		updatedAt: string;
		frontmatter: Record<string, unknown> | null;
	}

	let { projectId }: { projectId: string } = $props();

	let lessons = $state<Lesson[]>([]);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);

	// Click-to-confirm delete state — mirrors KnowledgeBaseTab.svelte.
	let confirmingDelete = $state<string | null>(null);
	let deleteTimeout: ReturnType<typeof setTimeout> | undefined;

	const VISIBILITY_ORDER = { user: 0, project: 1, global: 2 } as const;

	function timeAgo(dateStr: string | null): string {
		if (!dateStr) return "never";
		const now = Date.now();
		const then = new Date(dateStr).getTime();
		const diffMs = now - then;
		const minutes = Math.floor(diffMs / 60000);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	async function fetchLessons() {
		if (!projectId) {
			lessons = [];
			return;
		}
		// IMPORTANT: do NOT read `lessons.length` here. This function is
		// invoked from a `$effect`, which tracks every reactive read in
		// its synchronous prelude. Reading `lessons.length` would create
		// a feedback loop: assigning `lessons` later in this function
		// would mark the dep dirty, re-run the effect, re-fetch, ad
		// infinitum (and OOM the vitest worker). Always set loading = true
		// up front; it's stale at most for the current run.
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/lessons?projectId=${projectId}`);
			if (!res.ok) {
				errorMessage = `Failed to load lessons (${res.status})`;
				return;
			}
			lessons = (await res.json()) as Lesson[];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : "Failed to load lessons";
		} finally {
			loading = false;
		}
	}

	function handleDeleteClick(id: string) {
		if (confirmingDelete === id) {
			void doDelete(id);
		} else {
			confirmingDelete = id;
			clearTimeout(deleteTimeout);
			deleteTimeout = setTimeout(() => {
				confirmingDelete = null;
			}, 3000);
		}
	}

	async function doDelete(id: string) {
		confirmingDelete = null;
		errorMessage = null;
		try {
			const res = await fetch(`/api/lessons/${id}`, { method: "DELETE" });
			if (res.ok) {
				lessons = lessons.filter((l) => l.id !== id);
			} else {
				errorMessage = `Failed to delete (${res.status})`;
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : "Failed to delete";
		}
	}

	async function promoteVisibility(lesson: Lesson, next: Lesson["visibility"]) {
		if (VISIBILITY_ORDER[next] <= VISIBILITY_ORDER[lesson.visibility]) return;
		errorMessage = null;
		try {
			const res = await fetch(`/api/lessons/${lesson.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ visibility: next }),
			});
			if (res.ok) {
				const updated = (await res.json()) as Lesson;
				lessons = lessons.map((l) =>
					l.id === lesson.id ? { ...l, visibility: updated.visibility } : l,
				);
			} else {
				errorMessage = `Failed to update visibility (${res.status})`;
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : "Failed to update visibility";
		}
	}

	function visibilityBadgeClass(v: Lesson["visibility"]): string {
		// Tier-distinct badges so glanceability matches the data:
		//   user    → neutral grey  (private)
		//   project → blue          (shared with project)
		//   global  → amber         (shared everywhere — privileged)
		// The slug prefix uses the `%`-chip's sky styling so users can
		// recognize lesson rows at a glance.
		switch (v) {
			case "user":
				return "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]";
			case "project":
				return "bg-blue-800/40 text-blue-200";
			case "global":
				return "bg-amber-800/40 text-amber-200";
		}
	}

	$effect(() => {
		void projectId;
		fetchLessons();
		return () => {
			if (deleteTimeout) clearTimeout(deleteTimeout);
		};
	});
</script>

{#if loading}
	<div class="mt-4 text-sm text-[var(--color-text-muted)]" data-testid="lessons-loading">
		Loading...
	</div>
{:else if errorMessage}
	<div
		class="mt-4 rounded-lg border border-red-700/50 bg-red-950/30 p-4 text-sm text-red-300"
		data-testid="lessons-error"
		role="alert"
	>
		{errorMessage}
	</div>
{:else if lessons.length === 0}
	<div
		class="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]"
		data-testid="lessons-empty"
	>
		No lessons yet. Lessons appear here when the distiller captures them
		or you author one inline via <code>%</code>.
	</div>
{:else}
	<ul class="mt-4 space-y-4" data-testid="lessons-list">
		{#each lessons as lesson (lesson.id)}
			<li
				class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
				data-testid="lesson-row"
				data-lesson-id={lesson.id}
				data-owned-by-me={lesson.ownedByMe ? "true" : "false"}
				data-visibility={lesson.visibility}
			>
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span
								class="rounded border border-sky-500/30 bg-sky-500/20 px-1.5 py-0.5 font-mono text-xs text-sky-300"
								data-testid="lesson-slug"
							>%{lesson.slug}</span>
							<span
								class="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {visibilityBadgeClass(lesson.visibility)}"
								data-testid="lesson-visibility-badge"
							>
								{lesson.visibility}
							</span>
							{#if !lesson.ownedByMe}
								<span
									class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
									data-testid="lesson-shared-badge"
								>shared</span>
							{/if}
						</div>
						<h3 class="mt-1 text-base font-semibold text-[var(--color-text-primary)]">
							{lesson.title}
						</h3>
					</div>
					{#if lesson.ownedByMe}
						<div class="flex shrink-0 items-center gap-2" data-testid="lesson-actions">
							<select
								class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] disabled:opacity-50"
								disabled={lesson.visibility === "global"}
								value={lesson.visibility}
								onchange={(e) => {
									const next = (e.currentTarget as HTMLSelectElement).value as Lesson["visibility"];
									if (next !== lesson.visibility) {
										void promoteVisibility(lesson, next);
									}
								}}
								data-testid="lesson-promote"
								aria-label="Visibility"
							>
								<option
									value="user"
									disabled={VISIBILITY_ORDER["user"] < VISIBILITY_ORDER[lesson.visibility]}
								>user</option>
								<option
									value="project"
									disabled={VISIBILITY_ORDER["project"] < VISIBILITY_ORDER[lesson.visibility]}
								>project</option>
								<option value="global">global</option>
							</select>
							<button
								type="button"
								onclick={() => handleDeleteClick(lesson.id)}
								class="rounded px-2 py-1 text-xs transition-colors
									{confirmingDelete === lesson.id
										? 'bg-red-700 text-white'
										: 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-red-400'}"
								data-testid="lesson-delete"
							>
								{confirmingDelete === lesson.id ? "Confirm?" : "Delete"}
							</button>
						</div>
					{/if}
				</div>

				<!--
					Plain-text body display for v1.5. The popover preview uses
					a 60-char excerpt; here we show the full body. Markdown
					rendering is deferred to v2 — the existing MarkdownRenderer
					pulls in marked + highlight.js + a pair of DOM-mutating
					$effects which are heavy for the tab and known to cause
					issues in component-test runs. `whitespace-pre-wrap`
					preserves authored line breaks without HTML risk.
				-->
				<div
					class="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text-primary)]"
					data-testid="lesson-body"
				>{lesson.body}</div>

				<div
					class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]"
					data-testid="lesson-meta"
				>
					<span>source: {lesson.source}</span>
					<span>fired: {lesson.firedCount}</span>
					<span>last fired: {timeAgo(lesson.lastFiredAt)}</span>
					<span>dismissed: {lesson.dismissedCount}</span>
					<span>updated: {timeAgo(lesson.updatedAt)}</span>
				</div>
			</li>
		{/each}
	</ul>
{/if}
