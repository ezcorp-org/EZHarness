<script lang="ts">
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

	$effect(() => {
		void projectId;
		fetchFiles();
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
						<td class="py-2.5 text-[var(--color-text-primary)] flex items-center gap-2">
							<svg class="h-4 w-4 text-[var(--color-text-muted)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
							</svg>
							<span class="truncate max-w-[200px]">{file.filename}</span>
							{#if file.orgScoped}
								<span class="rounded bg-purple-800/50 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">Org</span>
							{/if}
						</td>
						<td class="py-2.5 text-[var(--color-text-secondary)]">{formatSize(file.fileSize)}</td>
						<td class="py-2.5">
							{#if file.status === "processing"}
								<span class="inline-flex items-center gap-1 text-yellow-400">
									<svg class="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
									</svg>
									Processing...
								</span>
							{:else if file.status === "error"}
								<span class="text-red-400">Error</span>
							{:else}
								<span class="text-[var(--color-text-secondary)]">{file.chunkCount}</span>
							{/if}
						</td>
						<td class="py-2.5 text-[var(--color-text-muted)]">{timeAgo(file.createdAt)}</td>
						<td class="py-2.5 text-right">
							<button
								onclick={() => handleDeleteClick(file.id)}
								class="rounded px-2 py-1 text-xs transition-colors
									{confirmingDelete === file.id
									? 'bg-red-700 text-white'
									: 'text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-[var(--color-surface-tertiary)]'}"
							>
								{confirmingDelete === file.id ? "Confirm?" : "Delete"}
							</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
