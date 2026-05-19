<script lang="ts">
	import { fetchDirContents, type FsEntry } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";
	import { sanitizePath, splitPath, filterByExtensions } from "./helpers.js";
	import type { ComponentSize } from "./types.js";

	let {
		value = $bindable(""),
		size = "sm" as ComponentSize,
		disabled = false,
		placeholder = "Enter file path...",
		options = {} as Record<string, unknown>,
		onchange,
	}: {
		value: string;
		size?: ComponentSize;
		disabled?: boolean;
		placeholder?: string;
		options?: Record<string, unknown>;
		onchange?: (value: string | string[]) => void;
	} = $props();

	let entries: FsEntry[] = $state([]);
	let open = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let containerEl: HTMLDivElement | undefined = $state();
	let dropdownEl: HTMLDivElement | undefined = $state();
	let highlightIdx = $state(-1);
	let inputEl: HTMLInputElement | undefined = $state();
	let dropdownStyle = $state("");

	const sizeClass = $derived(size === "sm" ? "py-1 text-xs" : "py-2 text-sm");
	const extensions = $derived(
		Array.isArray(options?.extensions) ? (options.extensions as string[]) : null,
	);

	function computeDropdownPosition() {
		if (!inputEl) return;
		const rect = inputEl.getBoundingClientRect();
		dropdownStyle = `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;width:${rect.width}px;z-index:9999;`;
	}

	async function loadEntries(dir: string) {
		try {
			let result = await fetchDirContents(sanitizePath(dir));
			if (extensions) {
				result = filterByExtensions(result, extensions) as typeof result;
			}
			entries = result;
		} catch {
			entries = [];
		}
	}

	function onInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(async () => {
			const { dir, partial } = splitPath(value);
			await loadEntries(dir);
			if (partial) {
				entries = entries.filter((e) =>
					e.name.toLowerCase().startsWith(partial.toLowerCase()),
				);
			}
			open = entries.length > 0;
			if (open) computeDropdownPosition();
		}, 200);
	}

	async function browse() {
		if (disabled) return;
		await loadEntries(value && !value.endsWith("/") ? splitPath(value).dir : value || "~");
		open = true;
		computeDropdownPosition();
	}

	function select(entry: FsEntry) {
		const { dir } = splitPath(value || "~/");
		const base = value.endsWith("/") ? value : dir + "/";
		const newPath = base === "/" ? "/" + entry.name : base + entry.name;
		value = newPath;
		if (entry.isDir) {
			value += "/";
			loadEntries(newPath).then(() => {
				open = entries.length > 0;
				if (open) computeDropdownPosition();
			});
		} else {
			open = false;
		}
		onchange?.(value);
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlightIdx = Math.min(highlightIdx + 1, entries.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlightIdx = Math.max(highlightIdx - 1, 0);
		} else if (e.key === "Enter" && highlightIdx >= 0) {
			e.preventDefault();
			select(entries[highlightIdx]!);
			highlightIdx = -1;
		} else if (e.key === "Escape") {
			open = false;
		}
	}

	function onClickOutside(e: MouseEvent) {
		const target = e.target as Node;
		if (containerEl?.contains(target)) return;
		if (dropdownEl?.contains(target)) return;
		open = false;
	}
</script>

<svelte:document onclick={onClickOutside} />

<div bind:this={containerEl}>
	<div class="flex gap-1">
		<input
			type="text"
			bind:this={inputEl}
			bind:value
			oninput={onInput}
			onkeydown={onKeydown}
			{placeholder}
			{disabled}
			class="{inputClass} flex-1 {sizeClass}"
		/>
		<button
			type="button"
			onclick={browse}
			{disabled}
			class="cursor-pointer rounded-md border border-[var(--color-border,#4b5563)] bg-[var(--color-surface-primary,#1f2937)] px-2.5 {sizeClass} text-[var(--color-text-secondary,#d1d5db)] hover:bg-[var(--color-surface-hover,#374151)] disabled:cursor-not-allowed disabled:opacity-50"
			title="Browse"
		>
			&#128193;
		</button>
	</div>
</div>

{#if open && entries.length > 0}
	<div style={dropdownStyle} bind:this={dropdownEl}>
		<ul
			class="max-h-52 overflow-y-auto rounded-md border border-[var(--color-border,#4b5563)] bg-[var(--color-surface-primary,#111827)] shadow-lg"
		>
			{#each entries as entry, i}
				<li>
					<button
						type="button"
						class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm {i ===
						highlightIdx
							? 'bg-blue-600 text-white'
							: 'text-[var(--color-text-secondary,#d1d5db)] hover:bg-[var(--color-surface-hover,#1f2937)]'}"
						onclick={() => select(entry)}
						onmouseenter={() => (highlightIdx = i)}
					>
						<span class="shrink-0">{entry.isDir ? "📁" : "📄"}</span>
						<span class="truncate">{entry.name}</span>
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
