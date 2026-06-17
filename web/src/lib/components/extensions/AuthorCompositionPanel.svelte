<!--
  AuthorCompositionPanel — Phase 4 §5.3 "Use other extensions".

  On the extension AUTHOR draft page. Two affordances, both writing the
  draft's `ezcorp.config.ts` source (NO hand-edit):
    1. "Use other extensions" → reuse ExtensionAttachPicker to pick
       installed extensions; the picks become `manifest.dependencies`
       (name+version). A non-fatal warning lists any declared dep not in
       the installed set (mirrors the runtime's silent drop).
    2. Capability toggles (Search / Memory / LLM) → write
       `permissions.<cap> = "inherit"` (the §3.1 grant shape).

  The component owns NO persistence: it computes the next source via the
  pure `ezcorp-config-edit` module and hands it back through `onsave`; the
  page writes it via the existing draft PUT. When the config source isn't
  the recognizable scaffold shape, the panel disables itself and tells the
  author to hand-edit (never corrupts the file).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import ExtensionAttachPicker from "$lib/components/ExtensionAttachPicker.svelte";
	import {
		isRecognizedConfig,
		parseDependencies,
		setDependencies,
		parseCapabilities,
		setCapabilityPermissions,
		unresolvedDependencies,
		unmanagedCapabilities,
		TOGGLEABLE_CAPABILITIES,
		type DependencyEntry,
		type ToggleableCapability,
		type InstalledExtensionRef,
	} from "$lib/ezcorp-config-edit.js";

	let {
		source,
		onsave,
	}: {
		/** The draft's current `ezcorp.config.ts` content. */
		source: string;
		/** Persist the mutated config source. Resolves on success. */
		onsave: (nextSource: string) => Promise<void>;
	} = $props();

	interface InstalledExt extends InstalledExtensionRef {
		id: string;
	}

	let installed = $state<InstalledExt[]>([]);
	let pickerOpen = $state(false);
	let saving = $state(false);
	let saveError = $state(false);

	const recognized = $derived(isRecognizedConfig(source));
	const deps = $derived(parseDependencies(source));
	const caps = $derived(parseCapabilities(source));
	const unresolved = $derived(unresolvedDependencies(deps, installed));
	// Caps whose value is a hand-written object ceiling or `false` — the
	// on/off toggle can't faithfully represent them, so it's READ-ONLY for
	// these (the edit module leaves them byte-for-byte untouched; this just
	// reflects that in the UI). Mirrors the Phase-3 multi-provider guard.
	const unmanaged = $derived(new Set(unmanagedCapabilities(source)));

	// Map current dependency NAMES → their installed ids, so re-opening the
	// picker preselects the already-declared deps.
	const selectedIds = $derived(
		deps
			.map((d) => installed.find((e) => e.name === d.name)?.id)
			.filter((id): id is string => typeof id === "string"),
	);

	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (res.ok) {
				const data = await res.json();
				const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.extensions) ? data.extensions : [];
				installed = list.map((e) => {
					const ext = e as Record<string, unknown>;
					const manifest = ext.manifest as { version?: string } | undefined;
					return {
						id: String(ext.id ?? ""),
						name: String(ext.name ?? ""),
						version: String(ext.version ?? manifest?.version ?? "0.0.0"),
					};
				});
			}
		} catch {
			/* silent — picker shows empty */
		}
	});

	async function persist(next: string) {
		saving = true;
		saveError = false;
		try {
			await onsave(next);
		} catch {
			saveError = true;
		} finally {
			saving = false;
		}
	}

	// Picker submit → map selected ids to {name, source:"bundled", version}
	// dependency entries (caret-ranged on the installed version), write the
	// managed dependencies block, persist.
	async function onPickerSubmit(ids: string[]) {
		pickerOpen = false;
		const chosen: DependencyEntry[] = ids
			.map((id) => installed.find((e) => e.id === id))
			.filter((e): e is InstalledExt => e !== undefined)
			.map((e) => ({ name: e.name, source: "bundled", version: `^${e.version}` }));
		const { source: next, recognized: ok } = setDependencies(source, chosen);
		if (ok) await persist(next);
	}

	async function toggleCapability(cap: ToggleableCapability) {
		// Defense-in-depth: an unmanaged (object/false) cap is read-only —
		// the button is disabled, but never attempt the edit either (the
		// module would no-op it, but this keeps the intent explicit).
		if (unmanaged.has(cap)) return;
		const nextCaps = { ...caps, [cap]: !caps[cap] };
		const { source: next, recognized: ok } = setCapabilityPermissions(source, nextCaps);
		if (ok) await persist(next);
	}

	function capLabel(cap: string): string {
		return cap.toUpperCase() === cap ? cap : cap.charAt(0).toUpperCase() + cap.slice(1);
	}
</script>

<div
	class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4"
	data-testid="author-composition-panel"
>
	<h3 class="mb-1 text-sm font-medium text-[var(--color-text-secondary)]">Compose with other extensions</h3>

	{#if !recognized}
		<p class="text-xs text-amber-400" data-testid="author-composition-unrecognized">
			This config doesn't match the scaffold shape — edit
			<code>ezcorp.config.ts</code> by hand to add dependencies or capabilities.
		</p>
	{:else}
		<!-- Capability toggles -->
		<div class="mb-4">
			<p class="mb-2 text-xs text-[var(--color-text-muted)]">Host capabilities</p>
			<div class="flex flex-wrap gap-2" data-testid="author-capability-toggles">
				{#each TOGGLEABLE_CAPABILITIES as cap}
					<button
						type="button"
						role="switch"
						aria-checked={caps[cap]}
						disabled={saving || unmanaged.has(cap)}
						title={unmanaged.has(cap) ? "Custom policy set in the manifest — edit the file directly" : undefined}
						onclick={() => toggleCapability(cap)}
						data-testid="author-capability-{cap}"
						class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50
							{caps[cap]
								? 'bg-blue-600 text-white'
								: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]'}"
					>
						{caps[cap] ? "☑" : "☐"} {capLabel(cap)}
					</button>
				{/each}
			</div>
			{#if unmanaged.size > 0}
				<p
					class="mt-2 rounded border border-amber-700 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-300"
					data-testid="author-capability-unmanaged-warning"
					role="status"
				>
					{[...unmanaged].join(", ")} {unmanaged.size === 1 ? "has" : "have"} a custom policy set
					in the manifest — edit <code>ezcorp.config.ts</code> directly to change it (the toggle is
					locked so it can't overwrite your ceiling).
				</p>
			{/if}
		</div>

		<!-- Dependencies -->
		<div>
			<div class="mb-2 flex items-center justify-between">
				<p class="text-xs text-[var(--color-text-muted)]">Uses extensions</p>
				<button
					type="button"
					disabled={saving}
					onclick={() => (pickerOpen = true)}
					data-testid="author-use-extensions-open"
					class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
				>
					Use other extensions
				</button>
			</div>

			{#if deps.length === 0}
				<p class="text-xs text-[var(--color-text-muted)]" data-testid="author-deps-empty">
					No dependencies declared.
				</p>
			{:else}
				<div class="flex flex-wrap gap-2" data-testid="author-deps-chips">
					{#each deps as dep (dep.name)}
						<span
							data-testid="author-dep-chip"
							data-dep-name={dep.name}
							class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text-primary)]"
						>
							<span class="font-medium">{dep.name}</span>
							<span class="text-[var(--color-text-muted)]">{dep.version}</span>
						</span>
					{/each}
				</div>
			{/if}

			{#if unresolved.length > 0}
				<p
					class="mt-2 rounded border border-amber-700 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-300"
					data-testid="author-unresolved-warning"
					role="status"
				>
					Not installed (will be dropped at runtime until installed):
					{unresolved.join(", ")}. Install still proceeds.
				</p>
			{/if}
		</div>

		{#if saveError}
			<p class="mt-2 text-xs text-red-400" data-testid="author-composition-error" role="alert">
				Save failed — try again
			</p>
		{/if}
	{/if}
</div>

<ExtensionAttachPicker
	open={pickerOpen}
	initialSelected={selectedIds}
	onclose={() => (pickerOpen = false)}
	onsubmit={onPickerSubmit}
/>
