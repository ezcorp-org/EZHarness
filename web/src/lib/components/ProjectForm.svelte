<script lang="ts">
	import type { Project } from "$lib/api.js";
	import { createDir, fetchFavicon } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";
	import FilePicker from "./FilePicker.svelte";

	let {
		project,
		onsubmit,
		submitting = false,
	}: {
		project?: Project;
		onsubmit: (data: { name: string; path: string; icon?: string | null; variables: Record<string, unknown> }) => void;
		submitting?: boolean;
	} = $props();

	let name = $state(project?.name ?? "");
	// Default to the host-accessible bind mount from docker-compose so new
	// projects are visible on the host at ./projects/ by default.
	let path = $state(project?.path ?? "/app/projects/");
	let icon = $state<string | null>(project?.icon ?? null);
	let faviconUrl = $state("");
	let fetchingFavicon = $state(false);
	let faviconError = $state("");
	let creatingFolder = $state(false);
	let folderMessage = $state<{ kind: "ok" | "err"; text: string } | null>(null);

	function handleSubmit(e: Event) {
		e.preventDefault();
		// Preserve any existing project variables on update; creation sends {}.
		onsubmit({ name, path, icon, variables: project?.variables ?? {} });
	}

	async function handleCreateFolder() {
		if (!path.trim()) {
			folderMessage = { kind: "err", text: "Enter a path first" };
			return;
		}
		creatingFolder = true;
		folderMessage = null;
		try {
			const result = await createDir(path);
			path = result.path;
			folderMessage = { kind: "ok", text: `Created ${result.path}` };
		} catch (e) {
			folderMessage = { kind: "err", text: e instanceof Error ? e.message : "Failed to create folder" };
		} finally {
			creatingFolder = false;
		}
	}

	function handleFileUpload(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = () => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				canvas.width = 128;
				canvas.height = 128;
				const ctx = canvas.getContext("2d")!;
				ctx.drawImage(img, 0, 0, 128, 128);
				icon = canvas.toDataURL("image/png");
			};
			img.src = reader.result as string;
		};
		reader.readAsDataURL(file);
	}

	async function handleFetchFavicon() {
		if (!faviconUrl.trim()) return;
		fetchingFavicon = true;
		faviconError = "";
		try {
			icon = await fetchFavicon(faviconUrl);
		} catch (e) {
			faviconError = e instanceof Error ? e.message : "Failed to fetch favicon";
		} finally {
			fetchingFavicon = false;
		}
	}

	const BG_COLORS = [
		"bg-blue-600", "bg-green-600", "bg-purple-600", "bg-orange-600",
		"bg-pink-600", "bg-teal-600", "bg-indigo-600", "bg-red-600",
	];

	function hashColor(n: string): string {
		let hash = 0;
		for (let i = 0; i < n.length; i++) hash = (hash * 31 + n.charCodeAt(i)) | 0;
		return BG_COLORS[Math.abs(hash) % BG_COLORS.length]!;
	}

</script>

<form onsubmit={handleSubmit} class="space-y-4">
	<!-- Icon -->
	<div>
		<div class="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Icon</div>
		<div class="flex items-center gap-4">
			<!-- Preview -->
			<div class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl {icon ? '' : hashColor(name || 'P')}">
				{#if icon}
					<img src={icon} alt="Project icon" class="h-full w-full object-cover" />
				{:else}
					<span class="text-2xl font-semibold text-white">{(name || "P").charAt(0).toUpperCase()}</span>
				{/if}
			</div>

			<div class="flex flex-col gap-2">
				<div class="flex gap-2">
					<label class="cursor-pointer rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]">
						Upload
						<input type="file" accept="image/*" class="hidden" onchange={handleFileUpload} />
					</label>
					{#if icon}
						<button
							type="button"
							onclick={() => (icon = null)}
							class="rounded-md px-3 py-1.5 text-xs text-red-400 hover:bg-[var(--color-surface-tertiary)]"
						>
							Remove
						</button>
					{/if}
				</div>
				<div class="flex gap-2">
					<input
						type="text"
						bind:value={faviconUrl}
						class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
						placeholder="https://example.com"
					/>
					<button
						type="button"
						onclick={handleFetchFavicon}
						disabled={fetchingFavicon}
						class="whitespace-nowrap rounded-md bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
					>
						{fetchingFavicon ? "..." : "Fetch"}
					</button>
				</div>
				{#if faviconError}
					<p class="text-xs text-red-400">{faviconError}</p>
				{/if}
			</div>
		</div>
	</div>

	<div>
		<label for="proj-name" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Name</label>
		<input id="proj-name" type="text" bind:value={name} required class={inputClass} placeholder="my-project" />
	</div>

	<div>
		<label for="proj-path" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Working Directory</label>
		<div class="flex gap-2">
			<div class="flex-1">
				<FilePicker bind:value={path} placeholder="/app/projects/my-project" />
			</div>
			<button
				type="button"
				onclick={handleCreateFolder}
				disabled={creatingFolder || !path.trim()}
				class="shrink-0 rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover,var(--color-surface-tertiary))] disabled:opacity-50"
			>
				{creatingFolder ? "Creating..." : "Create Folder"}
			</button>
		</div>
		{#if folderMessage}
			<p class="mt-1 text-xs {folderMessage.kind === 'ok' ? 'text-green-400' : 'text-red-400'}">{folderMessage.text}</p>
		{/if}
	</div>

	<button
		type="submit"
		disabled={submitting}
		class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
	>
		{submitting ? "Saving..." : project ? "Update" : "Create"}
	</button>
</form>
