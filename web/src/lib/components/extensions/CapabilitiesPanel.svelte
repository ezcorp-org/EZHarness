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
		providerOptions,
		isCustomFormValid,
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
	/** The cap whose Custom form failed empty-selection validation. */
	let validationCap = $state<string | null>(null);

	// Seed mode + form from the incoming grants/effective whenever the
	// capabilities prop changes (post-save reload). onMount-free: this is a
	// pure projection of props, not a fetch.
	$effect(() => {
		const nextMode: Record<string, CapabilityMode> = {};
		const nextForms: Record<string, CapabilityForm> = {};
		for (const c of capabilities) {
			nextMode[c.cap] = grantToMode(c.grant);
			// Seed the multi-select from the effective providers, intersected
			// with the provider set the UI offers. A pre-existing N-provider
			// grant round-trips verbatim (N checked boxes) — no preserve hack.
			nextForms[c.cap] = formFromEffective(effectiveView(c), providerOptions(c));
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

	async function setMode(cap: string, next: CapabilityMode) {
		mode = { ...mode, [cap]: next };
		// Clear any stale validation/save error when switching modes.
		if (errorCap === cap) errorCap = null;
		validationCap = validationCap === cap ? null : validationCap;
	}

	/** Toggle a provider in the Custom multi-select. */
	function toggleProvider(cap: string, provider: string, checked: boolean) {
		const cur = forms[cap]!.providers;
		const next = checked ? [...cur, provider] : cur.filter((p) => p !== provider);
		forms[cap]!.providers = next;
		// A non-empty selection clears the empty-selection validation error.
		if (next.length > 0 && validationCap === cap) validationCap = null;
	}

	async function save(c: HeldCapabilityView) {
		if (!isAdmin) return;
		const cap = c.cap;
		// Custom mode requires at least one provider — an empty allowlist
		// would deny every provider. Block save with a validation error.
		if (mode[cap] === "custom" && !isCustomFormValid(forms[cap]!)) {
			validationCap = cap;
			return;
		}
		savingCap = cap;
		errorCap = null;
		validationCap = null;
		try {
			const grant = grantForMode(mode[cap]!, forms[cap]!, effectiveView(c), providerOptions(c));
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
						<!-- Multi-provider allowlist: a first-class checkbox group over
						     the KNOWN providers. Any subset (1..N) round-trips natively —
						     no preserve hack. An empty selection is a validation error
						     (an empty allowlist would deny every provider). -->
						<div class="space-y-1.5" data-testid="capability-{c.cap}-providers-group" role="group" aria-label="Allowed providers">
							<span class="text-xs text-[var(--color-text-secondary)]">Allowed providers</span>
							<div class="flex flex-wrap gap-2">
								{#each providerOptions(c) as prov}
									<label
										class="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
									>
										<input
											type="checkbox"
											checked={forms[c.cap]!.providers.includes(prov)}
											onchange={(e) => toggleProvider(c.cap, prov, e.currentTarget.checked)}
											disabled={!isAdmin}
											data-testid="capability-{c.cap}-provider-{prov}"
										/>
										{prov}
									</label>
								{/each}
							</div>
							{#if validationCap === c.cap}
								<p
									class="text-xs text-red-400"
									data-testid="capability-{c.cap}-providers-error"
									role="alert"
								>
									Select at least one provider, or choose Inherit / Disabled.
								</p>
							{/if}
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
