<script lang="ts">
	const ALLOWED_EXTENSIONS = new Set([
		".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".toml",
		".ts", ".js", ".py", ".go", ".rs",
		".html", ".xml", ".css",
		".sh", ".sql", ".env", ".cfg", ".ini", ".log",
	]);

	const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

	let {
		projectId,
		onuploaded,
	}: {
		projectId: string;
		onuploaded: () => void;
	} = $props();

	let dragOver = $state(false);
	interface UploadEntry { name: string; done: boolean; error?: string }
	let uploading = $state<UploadEntry[]>([]);
	let errorMsg = $state("");

	function isAllowedFile(filename: string): boolean {
		const dot = filename.lastIndexOf(".");
		if (dot === -1) return false;
		return ALLOWED_EXTENSIONS.has(filename.slice(dot).toLowerCase());
	}

	function formatAllowed(): string {
		return [...ALLOWED_EXTENSIONS].join(", ");
	}

	async function uploadFiles(files: FileList | File[]) {
		errorMsg = "";
		const fileArray = Array.from(files);
		const validFiles: File[] = [];

		for (const file of fileArray) {
			if (!isAllowedFile(file.name)) {
				errorMsg = `Rejected: ${file.name} (unsupported type). Allowed: ${formatAllowed()}`;
				continue;
			}
			if (file.size > MAX_FILE_SIZE) {
				errorMsg = `Rejected: ${file.name} (exceeds 10MB limit)`;
				continue;
			}
			validFiles.push(file);
		}

		if (validFiles.length === 0) return;

		const entries: UploadEntry[] = validFiles.map((f) => ({ name: f.name, done: false }));
		uploading = [...uploading, ...entries];

		for (let i = 0; i < validFiles.length; i++) {
			const file = validFiles[i]!;
			const entry = entries[i]!;
			try {
				const formData = new FormData();
				formData.append("file", file);
				formData.append("projectId", projectId);

				const res = await fetch("/api/knowledge-base", {
					method: "POST",
					body: formData,
				});

				if (!res.ok) {
					const data = await res.json().catch(() => ({ error: "Upload failed" }));
					entry.error = data.error ?? "Upload failed";
				} else {
					entry.done = true;
				}
			} catch {
				entry.error = "Network error";
			}
			// Trigger reactivity
			uploading = [...uploading];
		}

		onuploaded();

		// Clear completed uploads after a short delay
		setTimeout(() => {
			uploading = uploading.filter((u) => !u.done && !u.error);
		}, 2000);
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files) {
			uploadFiles(e.dataTransfer.files);
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function handleDragLeave() {
		dragOver = false;
	}

	let fileInput: HTMLInputElement | undefined = $state();

	function handleClick() {
		fileInput?.click();
	}

	function handleFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			uploadFiles(input.files);
			input.value = "";
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors
		{dragOver
		? 'border-blue-400 bg-blue-900/20'
		: 'border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-surface-secondary)]/50'}"
	ondrop={handleDrop}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	onclick={handleClick}
	role="button"
	tabindex="0"
	onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
>
	<input
		bind:this={fileInput}
		type="file"
		multiple
		class="hidden"
		onchange={handleFileChange}
	/>
	<svg class="mx-auto h-8 w-8 text-[var(--color-text-muted)] mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
		<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
	</svg>
	<p class="text-sm text-[var(--color-text-secondary)]">
		{dragOver ? "Drop files here" : "Drop files here or click to upload"}
	</p>
	<p class="mt-1 text-xs text-[var(--color-text-muted)]">Text files up to 10MB (.txt, .md, .json, .ts, .py, etc.)</p>
</div>

{#if errorMsg}
	<div class="mt-2 rounded-md border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-300">
		{errorMsg}
	</div>
{/if}

{#if uploading.length > 0}
	<div class="mt-2 space-y-1">
		{#each uploading as item}
			<div class="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
				{#if item.error}
					<svg class="h-3.5 w-3.5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
					<span class="text-red-400">{item.name}: {item.error}</span>
				{:else if item.done}
					<svg class="h-3.5 w-3.5 text-green-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
					<span class="text-green-400">{item.name}</span>
				{:else}
					<svg class="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
					<span>{item.name}</span>
				{/if}
			</div>
		{/each}
	</div>
{/if}
