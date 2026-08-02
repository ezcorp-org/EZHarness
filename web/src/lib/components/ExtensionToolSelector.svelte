<script lang="ts">
	import { onMount } from "svelte";
	import {
		isAllTools as logicIsAllTools,
		isToolChecked,
		selectedLabel as logicSelectedLabel,
		toggleTool as logicToggleTool,
		selectAllTools as logicSelectAllTools,
	} from "$lib/tool-scope-logic";
	import { parseExtensionList, type ExtensionToolSource } from "$lib/extension-tool-options";

	// Per-extension tool subset selector. Renders one section per attached
	// extension with a checklist of its tools. The toggle/collapse rules live
	// in the shared pure module `$lib/tool-scope-logic` (the data model: a key
	// absent or mapping to an empty array means "all tools"); parsing the
	// /api/extensions payload lives in `$lib/extension-tool-options`, shared
	// with the workflow builder's tool-step picker.
	type ExtInfo = ExtensionToolSource;

	let {
		extensionIds = [],
		value = {},
		onchange,
		readonly = false,
	}: {
		extensionIds?: string[];
		value?: Record<string, string[]>;
		onchange?: (map: Record<string, string[]>) => void;
		readonly?: boolean;
	} = $props();

	let extData = $state<Record<string, ExtInfo>>({});
	let loaded = $state(false);

	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (res.ok) {
				const map: Record<string, ExtInfo> = {};
				for (const ext of parseExtensionList(await res.json())) map[ext.id] = ext;
				extData = map;
			}
		} catch { /* non-fatal */ }
		finally { loaded = true; }
	});

	// Extensions that are attached AND resolved (in attachment order).
	let sections = $derived(
		extensionIds.map((id) => extData[id]).filter((e): e is ExtInfo => Boolean(e)),
	);

	function toolNames(ext: ExtInfo): string[] {
		return ext.tools.map((t) => t.name);
	}

	function isAllTools(extId: string): boolean {
		return logicIsAllTools(value, extId);
	}

	function isChecked(ext: ExtInfo, toolName: string): boolean {
		return isToolChecked(value, ext.id, toolName);
	}

	function selectedLabel(ext: ExtInfo): string {
		return logicSelectedLabel(value, ext.id);
	}

	function toggleTool(ext: ExtInfo, toolName: string) {
		if (readonly) return;
		onchange?.(logicToggleTool(value, ext.id, toolName, toolNames(ext)));
	}

	function selectAll(ext: ExtInfo) {
		if (readonly) return;
		onchange?.(logicSelectAllTools(value, ext.id));
	}
</script>

{#if loaded && sections.length > 0}
	<div class="space-y-2" data-testid="extension-tool-selector">
		{#each sections as ext (ext.id)}
			<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-2">
				<div class="mb-1 flex items-center justify-between">
					<span class="text-xs font-medium text-[var(--color-text-primary)]">{ext.name}</span>
					{#if readonly}
						<span class="text-xs text-[var(--color-text-muted)]">{selectedLabel(ext)}</span>
					{:else if !isAllTools(ext.id) && ext.tools.length > 0}
						<button
							type="button"
							class="text-xs text-[var(--color-accent)] hover:underline"
							onclick={() => selectAll(ext)}
							data-testid={`select-all-${ext.id}`}
						>
							Select all
						</button>
					{:else}
						<span class="text-xs text-[var(--color-text-muted)]">All tools</span>
					{/if}
				</div>
				{#if ext.tools.length === 0}
					<p class="text-xs italic text-[var(--color-text-muted)]">No tools exposed.</p>
				{:else if readonly}
					<!-- Readonly: chips already summarized above; nothing interactive. -->
				{:else}
					<div class="flex flex-col gap-1">
						{#each ext.tools as tool (tool.name)}
							{@const checked = isChecked(ext, tool.name)}
							<label class="flex cursor-pointer items-start gap-2 text-xs text-[var(--color-text-secondary)]">
								<input
									type="checkbox"
									class="mt-0.5"
									{checked}
									onchange={() => toggleTool(ext, tool.name)}
									data-testid={`tool-${ext.id}-${tool.name}`}
								/>
								<span class="min-w-0 flex-1">
									<span class="font-mono text-[var(--color-text-primary)]">{tool.name}</span>
									{#if tool.description}
										<span class="block truncate text-[var(--color-text-muted)]">{tool.description}</span>
									{/if}
								</span>
							</label>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
