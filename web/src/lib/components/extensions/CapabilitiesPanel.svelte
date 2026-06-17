<!--
  CapabilitiesPanel — Phase 3 §5.2.

  Renders the per-capability Inherit / Custom / Disabled control for every
  HOST capability the extension HOLDS (v1: search). This is an
  instance-wide SECURITY CEILING, so it's admin-only + writes the GRANT
  (`grantedPermissions.search`) via the existing admin permissions PUT —
  NOT the per-user extension_settings endpoint.

  - Inherit  → grant `"inherit"` (effective values track the instance default)
  - Custom   → reveals the capability schema fields prefilled with the
               inherited/effective values; saves a FIELD-LEVEL partial override
  - Disabled → grant `false` (handler soft-fails the capability)

  A non-admin viewer sees the section READ-ONLY (the current mode + effective
  values) and cannot write — the per-user Extension settings section stays
  editable for them, unaffected by this panel.
-->
<script lang="ts">
	import {
		grantToMode,
		formFromEffective,
		grantForMode,
		hasPreservedProviderList,
		type CapabilityMode,
		type EffectivePolicyView,
		type SearchGrant,
		type CapabilityForm,
		type HeldCapabilityView,
	} from "$lib/capability-policy-ui.js";

	let {
		capabilities,
		isAdmin = false,
		onsave,
	}: {
		capabilities: HeldCapabilityView[];
		isAdmin?: boolean;
		/** Persist a grant override for `cap`. Resolves on success; the
		 *  parent PUTs the permissions route + reloads. */
		onsave: (cap: string, grant: SearchGrant) => Promise<void>;
	} = $props();

	// Per-capability local UI state, keyed by cap. Derived from the grant
	// on first render; the parent reloads `capabilities` after a save.
	let mode = $state<Record<string, CapabilityMode>>({});
	let forms = $state<Record<string, CapabilityForm>>({});
	let savingCap = $state<string | null>(null);
	let errorCap = $state<string | null>(null);

	// Seed mode + form from the incoming grants/effective whenever the
	// capabilities prop changes (post-save reload). onMount-free: this is a
	// pure projection of props, not a fetch.
	$effect(() => {
		const nextMode: Record<string, CapabilityMode> = {};
		const nextForms: Record<string, CapabilityForm> = {};
		for (const c of capabilities) {
			nextMode[c.cap] = grantToMode(c.grant);
			// Pass the RAW grant so a multi-provider allowlist is captured into
			// `providersOriginal` and preserved on save (no silent widening).
			nextForms[c.cap] = formFromEffective(effectiveView(c), c.grant);
		}
		mode = nextMode;
		forms = nextForms;
	});

	function effectiveView(c: HeldCapabilityView): EffectivePolicyView {
		// A denied (false-grant) capability has no enforced numbers; fall
		// back to the schema defaults for the Custom prefill.
		const q = typeof c.effective.quota === "number" ? c.effective.quota : numDefault(c, "quota");
		const m = typeof c.effective.maxResults === "number" ? c.effective.maxResults : numDefault(c, "maxResults");
		const p = c.effective.providers ?? "all";
		return { quota: q, maxResults: m, providers: p };
	}

	function numDefault(c: HeldCapabilityView, key: string): number {
		const f = c.schema.find((s) => s.key === key)?.field;
		return f && f.type === "number" && typeof f.default === "number" ? f.default : 1;
	}

	function selectOptions(c: HeldCapabilityView): { value: string; label: string }[] {
		const f = c.schema.find((s) => s.key === "providers")?.field;
		return f && f.type === "select" ? f.options : [];
	}

	async function setMode(cap: string, next: CapabilityMode) {
		mode = { ...mode, [cap]: next };
	}

	async function save(c: HeldCapabilityView) {
		if (!isAdmin) return;
		const cap = c.cap;
		savingCap = cap;
		errorCap = null;
		try {
			const grant = grantForMode(mode[cap]!, forms[cap]!, effectiveView(c));
			await onsave(cap, grant);
		} catch {
			errorCap = cap;
		} finally {
			savingCap = null;
		}
	}

	function capLabel(cap: string): string {
		return cap.charAt(0).toUpperCase() + cap.slice(1);
	}
</script>

{#if capabilities.length > 0}
	<div
		class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
		data-testid="capabilities-panel"
	>
		<h4 class="mb-1 text-sm font-medium text-[var(--color-text-secondary)]">Capabilities</h4>
		<p class="mb-3 text-xs text-[var(--color-text-muted)]">
			Instance-wide policy for the host capabilities this extension holds. Admin-only — a
			per-user preference can never raise these.
		</p>

		{#each capabilities as c (c.cap)}
			<div class="mb-4 border-t border-[var(--color-border)] pt-3 first:border-t-0 first:pt-0" data-testid="capability-row-{c.cap}">
				<div class="mb-2 flex items-center justify-between gap-2">
					<span class="text-sm font-medium text-[var(--color-text-primary)]">{capLabel(c.cap)}</span>
					{#if !isAdmin}
						<span class="text-xs text-[var(--color-text-muted)]" data-testid="capability-{c.cap}-readonly">
							admin-managed
						</span>
					{/if}
				</div>

				<!-- Inherit / Custom / Disabled segmented control -->
				<div class="flex gap-1" role="radiogroup" aria-label="{capLabel(c.cap)} policy mode">
					{#each ["inherit", "custom", "disabled"] as const as m}
						<button
							type="button"
							role="radio"
							aria-checked={mode[c.cap] === m}
							disabled={!isAdmin || savingCap === c.cap}
							onclick={() => setMode(c.cap, m)}
							data-testid="capability-{c.cap}-mode-{m}"
							class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50
								{mode[c.cap] === m
									? 'bg-blue-600 text-white'
									: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)]'}"
						>
							{m.charAt(0).toUpperCase() + m.slice(1)}
						</button>
					{/each}
				</div>

				<!-- Inherit: show the effective (instance-default) values read-only -->
				{#if mode[c.cap] === "inherit"}
					<p class="mt-2 text-xs text-[var(--color-text-secondary)]" data-testid="capability-{c.cap}-inherit-summary">
						Inheriting instance defaults: quota {effectiveView(c).quota}, max results
						{effectiveView(c).maxResults}, providers
						{effectiveView(c).providers === "all" ? "all" : (effectiveView(c).providers as string[]).join(", ")}.
					</p>
				{/if}

				<!-- Custom: reveal the schema fields prefilled with inherited values -->
				{#if mode[c.cap] === "custom" && forms[c.cap]}
					<div class="mt-3 space-y-3" data-testid="capability-{c.cap}-custom-fields">
						<!-- Multi-provider allowlist guard: the single-select can't
						     represent a >1 provider list, so it's PRESERVED verbatim
						     (not silently widened to inherit). Warn until the admin
						     actively changes the select. -->
						{#if hasPreservedProviderList(forms[c.cap]!)}
							<p
								class="rounded border border-amber-700 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-300"
								data-testid="capability-{c.cap}-providers-preserved"
								role="status"
							>
								This extension is restricted to multiple providers
								({(forms[c.cap]!.providersOriginal ?? []).join(", ")}). That list is
								preserved as-is — changing the selector below replaces it with a single
								provider or inherits the default.
							</p>
						{/if}
						<div class="flex items-center justify-between gap-3">
							<label for="cap-{c.cap}-providers" class="text-xs text-[var(--color-text-secondary)]">Allowed providers</label>
							<select
								id="cap-{c.cap}-providers"
								bind:value={forms[c.cap]!.providers}
								onchange={() => (forms[c.cap]!.providersDirty = true)}
								disabled={!isAdmin}
								data-testid="capability-{c.cap}-field-providers"
								class="w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
							>
								{#each selectOptions(c) as opt}
									<option value={opt.value}>{opt.label}</option>
								{/each}
							</select>
						</div>
						<div class="flex items-center justify-between gap-3">
							<label for="cap-{c.cap}-quota" class="text-xs text-[var(--color-text-secondary)]">Daily quota</label>
							<input
								id="cap-{c.cap}-quota"
								type="number"
								min="1"
								bind:value={forms[c.cap]!.quota}
								disabled={!isAdmin}
								data-testid="capability-{c.cap}-field-quota"
								class="w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
							/>
						</div>
						<div class="flex items-center justify-between gap-3">
							<label for="cap-{c.cap}-maxresults" class="text-xs text-[var(--color-text-secondary)]">Max results</label>
							<input
								id="cap-{c.cap}-maxresults"
								type="number"
								min="1"
								bind:value={forms[c.cap]!.maxResults}
								disabled={!isAdmin}
								data-testid="capability-{c.cap}-field-maxresults"
								class="w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
							/>
						</div>
					</div>
				{/if}

				<!-- Disabled: explain the effect -->
				{#if mode[c.cap] === "disabled"}
					<p class="mt-2 text-xs text-[var(--color-text-secondary)]" data-testid="capability-{c.cap}-disabled-summary">
						Search is disabled for this extension — calls soft-fail.
					</p>
				{/if}

				{#if isAdmin}
					<div class="mt-3 flex items-center gap-2">
						<button
							type="button"
							onclick={() => save(c)}
							disabled={savingCap === c.cap}
							data-testid="capability-{c.cap}-save"
							class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
						>
							{savingCap === c.cap ? "Saving…" : "Save"}
						</button>
						{#if errorCap === c.cap}
							<span class="text-xs text-red-400" data-testid="capability-{c.cap}-error" role="alert">Save failed — try again</span>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
