<script lang="ts">
	import { untrack } from "svelte";
	import FileUpload from "./FileUpload.svelte";

	interface KBFile {
		id: string;
		projectId: string;
		orgScoped: boolean;
		filename: string;
		mimeType: string;
		fileSize: number;
		chunkCount: number;
		status: "processing" | "ready" | "error";
		createdAt: string;
		/**
		 * Sharing state, computed SERVER-side by `describeKBFileSharing`
		 * (`src/memory/kb-sharing.ts`) — the same functions
		 * `/api/knowledge-base/[id]/share` enforces with. Deliberately not
		 * re-derived here: the client does not know the caller's user id or their
		 * project membership, and a second copy of the rule is how you get a
		 * button that 403s. Optional because older payloads (and the delete-path
		 * optimistic updates below) may not carry them.
		 */
		shared?: boolean;
		sharedByYou?: boolean;
		canShare?: boolean;
		canUnshare?: boolean;
	}

	let {
		projectId,
	}: {
		projectId: string;
	} = $props();

	let files = $state<KBFile[]>([]);
	let loading = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let confirmingDelete = $state<string | null>(null);
	let deleteTimeout: ReturnType<typeof setTimeout> | undefined;
	/** The file id whose share/un-share request is in flight, if any. */
	let sharing = $state<string | null>(null);
	/** Last share/un-share failure, shown inline rather than swallowed. */
	let shareError = $state<string | null>(null);

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function timeAgo(dateStr: string): string {
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

	async function fetchFiles() {
		loading = files.length === 0;
		try {
			const res = await fetch(`/api/knowledge-base?projectId=${projectId}`);
			if (res.ok) {
				files = await res.json();
				managePoll();
			}
		} catch {
			// silent
		}
		loading = false;
	}

	function managePoll() {
		const hasProcessing = files.some((f) => f.status === "processing");
		if (hasProcessing && !pollTimer) {
			pollTimer = setInterval(fetchFiles, 3000);
		} else if (!hasProcessing && pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	function handleDeleteClick(fileId: string) {
		if (confirmingDelete === fileId) {
			doDelete(fileId);
		} else {
			confirmingDelete = fileId;
			clearTimeout(deleteTimeout);
			deleteTimeout = setTimeout(() => {
				confirmingDelete = null;
			}, 3000);
		}
	}

	async function doDelete(fileId: string) {
		confirmingDelete = null;
		try {
			const res = await fetch(`/api/knowledge-base/${fileId}`, { method: "DELETE" });
			if (res.ok) {
				files = files.filter((f) => f.id !== fileId);
			}
		} catch {
			// silent
		}
	}

	/**
	 * Share the file with the project, or take it back.
	 *
	 * Both verbs hit the same path so the pair reads as one thing;
	 * `POST` shares, `DELETE` un-shares. The response is NOT merged into the row
	 * — a full `fetchFiles()` re-reads the server's recomputed `canShare` /
	 * `canUnshare` for EVERY row, which is the only way the buttons stay
	 * truthful (un-sharing, for instance, restores an owner and so flips a
	 * different set of affordances than the one row that changed).
	 */
	async function toggleShare(file: KBFile) {
		if (sharing) return;
		sharing = file.id;
		shareError = null;
		try {
			const res = await fetch(`/api/knowledge-base/${file.id}/share`, {
				method: file.shared ? "DELETE" : "POST",
			});
			if (res.ok) {
				await fetchFiles();
			} else {
				const body = await res.json().catch(() => ({}));
				shareError = body?.error ?? "Could not change sharing for this file.";
			}
		} catch {
			shareError = "Could not reach the server.";
		}
		sharing = null;
	}

	$effect(() => {
		// `projectId` is the ONE thing this effect reacts to — read it here, on
		// purpose, and run everything else untracked.
		//
		// Without `untrack` this was an unbounded request loop: `fetchFiles`
		// reads `files.length` SYNCHRONOUSLY (before its first `await`), so
		// `files` became a dependency of the effect; the same call then assigns
		// `files = await res.json()` — a fresh array every time — which
		// invalidated the effect and re-ran it. Measured at ~1800 requests in
		// four seconds for as long as the tab stayed open, hammering
		// `GET /api/knowledge-base` and never settling (it is also why the page
		// never reached Playwright's `networkidle`).
		void projectId;
		untrack(() => fetchFiles());
		return () => {
			if (pollTimer) clearInterval(pollTimer);
		};
	});
</script>

<FileUpload {projectId} onuploaded={fetchFiles} />

{#if loading}
	<div class="mt-4 text-sm text-[var(--color-text-muted)]">Loading...</div>
{:else if files.length === 0}
	<div class="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]">
		No files uploaded yet. Drop files above to get started.
	</div>
{:else}
	{#if shareError}
		<div
			role="alert"
			data-testid="kb-share-error"
			class="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
		>{shareError}</div>
	{/if}
	<div class="mt-4 overflow-x-auto">
		<table class="w-full text-sm text-left">
			<thead class="text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
				<tr>
					<th class="pb-2 font-medium">Filename</th>
					<th class="pb-2 font-medium">Size</th>
					<th class="pb-2 font-medium">Chunks</th>
					<th class="pb-2 font-medium">Uploaded</th>
					<th class="pb-2 font-medium text-right">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each files as file (file.id)}
					<tr class="border-b border-[var(--color-border)]/50 last:border-0">
						<!-- `flex` lives on an inner div, not the <td>: a flex table-cell drops
						     out of the table's column-sizing and vertical-align model, so the
						     Filename column stopped agreeing with its own <th>. -->
						<td class="py-2.5 text-[var(--color-text-primary)]">
							<div class="flex items-center gap-2">
								<svg class="h-4 w-4 text-[var(--color-text-muted)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
								</svg>
								<span class="truncate max-w-[200px]">{file.filename}</span>
								<!-- Both pills are light-first with a `dark:` override
								     (`@custom-variant dark` in app.css keys off `.dark`). The
								     dark-only form these used — a `-800/50` wash under `-300`
								     text — is pale-on-pale on the LIGHT content surface this
								     table actually sits on, which is where the Org badge had
								     been sitting unreadable. -->
								{#if file.orgScoped}
									<span class="shrink-0 rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-800/50 dark:text-purple-300">Org</span>
								{/if}
								{#if file.shared}
									<span
										class="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-800/50 dark:text-emerald-300"
										title={file.sharedByYou
											? "You shared this file. Everyone on the project can read it, and it is retrieved into their chats."
											: "Shared with the project. Everyone on the project can read it, and it is retrieved into their chats."}
									>{file.sharedByYou ? "Shared by you" : "Shared"}</span>
								{/if}
							</div>
						</td>
						<td class="py-2.5 text-[var(--color-text-secondary)]">{formatSize(file.fileSize)}</td>
						<td class="py-2.5">
							<!-- Same light-first treatment: `text-yellow-400` / `text-red-400`
							     are dark-surface values and were ~1.7:1 on the light table. -->
							{#if file.status === "processing"}
								<span class="inline-flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
									<svg class="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
									</svg>
									Processing...
								</span>
							{:else if file.status === "error"}
								<span class="text-red-600 dark:text-red-400">Error</span>
							{:else}
								<span class="text-[var(--color-text-secondary)]">{file.chunkCount}</span>
							{/if}
						</td>
						<td class="py-2.5 text-[var(--color-text-muted)]">{timeAgo(file.createdAt)}</td>
						<td class="py-2.5 text-right">
							<div class="flex items-center justify-end gap-1">
								<!-- Shown only when the SERVER says the action would succeed
								     (`canShare`/`canUnshare` come from the same module the share
								     route enforces with), so this is never a button that 403s. -->
								{#if file.canShare || file.canUnshare}
									<button
										onclick={() => toggleShare(file)}
										disabled={sharing !== null}
										title={file.canUnshare
											? "Stop sharing: return this file to its owner. It leaves everyone else's chat retrieval."
											: "Share with the project: every member can read it, and it is retrieved into their chats."}
										class="rounded px-2 py-1 text-xs transition-colors disabled:opacity-50
											text-[var(--color-text-secondary)] hover:text-emerald-300 hover:bg-[var(--color-surface-tertiary)]"
									>
										{sharing === file.id ? "…" : file.canUnshare ? "Unshare" : "Share"}
									</button>
								{/if}
								<button
									onclick={() => handleDeleteClick(file.id)}
									class="rounded px-2 py-1 text-xs transition-colors
										{confirmingDelete === file.id
										? 'bg-red-700 text-white'
										: 'text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-[var(--color-surface-tertiary)]'}"
								>
									{confirmingDelete === file.id ? "Confirm?" : "Delete"}
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
