<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import {
		SEARCH_DEFAULT_KEYS,
		providersFromText,
		sanitizeQuota,
		sanitizeMaxResults,
		type SearchDefaultsForm,
	} from "$lib/settings-search-config.js";

	// The whole form is $bindable so the page owns the source of truth
	// (loaded once via fetchSettings) — mirrors models/+page.svelte.
	let { defaults = $bindable() }: { defaults: SearchDefaultsForm } = $props();

	const flash = createSaveFlash();

	// Each control auto-saves on change with optimistic rollback — the
	// established settings pattern (DefaultTierSection). We REASSIGN the
	// whole `defaults` object on every mutation (rather than poking a
	// nested field) so the top-level bindable changes — reactive whether
	// the parent passed a $state proxy or a plain object.
	async function commit(
		key: string,
		next: SearchDefaultsForm,
		value: unknown,
		previous: SearchDefaultsForm,
	) {
		defaults = next;
		const ok = await flash.run(() => upsertSetting(key, value));
		if (!ok) defaults = previous; // roll back the optimistic mutation
	}

	async function toggleAllowed() {
		const previous = { ...defaults };
		const value = !previous.allowedByDefault;
		await commit(SEARCH_DEFAULT_KEYS.allowedByDefault, { ...previous, allowedByDefault: value }, value, previous);
	}

	async function commitQuota() {
		const previous = { ...defaults };
		const value = sanitizeQuota(defaults.quota);
		await commit(SEARCH_DEFAULT_KEYS.defaultQuota, { ...previous, quota: value }, value, previous);
	}

	async function commitMaxResults() {
		const previous = { ...defaults };
		const value = sanitizeMaxResults(defaults.maxResults);
		await commit(SEARCH_DEFAULT_KEYS.defaultMaxResults, { ...previous, maxResults: value }, value, previous);
	}

	async function commitProviders() {
		const previous = { ...defaults };
		const parsed = providersFromText(defaults.providers);
		// Normalize the field to the canonical display form.
		const text = parsed === "all" ? "all" : parsed.join(", ");
		await commit(SEARCH_DEFAULT_KEYS.defaultProviders, { ...previous, providers: text }, parsed, previous);
	}
</script>

<SettingsSection
	id="search-defaults"
	title="Defaults for Extensions"
	tooltip="The instance-wide policy applied to every extension that holds the search capability and inherits (the default). An extension's per-extension override, when set, takes precedence field-by-field. These are a ceiling — a per-user preference can never raise a quota or widen providers."
	description="Set the search policy new and inheriting extensions get. Changes save automatically and propagate to every inheriting extension."
>
	<div class="space-y-4" data-testid="search-defaults">
		<!-- allowedByDefault -->
		<div class="flex items-center justify-between gap-4">
			<div>
				<p class="text-sm font-medium text-[var(--color-text-primary)]">Allow search by default</p>
				<p class="text-xs text-[var(--color-text-secondary)]">
					New search-capable extensions are granted (inherit) rather than disabled at install.
				</p>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={defaults.allowedByDefault}
				aria-label="Allow search by default"
				data-testid="search-default-allowed"
				onclick={toggleAllowed}
				disabled={flash.saving}
				class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors {defaults.allowedByDefault
					? 'bg-blue-600'
					: 'bg-[var(--color-surface-tertiary)]'}"
			>
				<span
					class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform {defaults.allowedByDefault
						? 'translate-x-6'
						: 'translate-x-1'}"
				></span>
			</button>
		</div>

		<!-- defaultQuota -->
		<div class="flex items-center justify-between gap-4">
			<label for="search-default-quota" class="text-sm font-medium text-[var(--color-text-primary)]">
				Default daily quota
			</label>
			<input
				id="search-default-quota"
				type="number"
				min="1"
				data-testid="search-default-quota"
				bind:value={defaults.quota}
				onchange={commitQuota}
				disabled={flash.saving}
				class="w-28 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
		</div>

		<!-- defaultMaxResults -->
		<div class="flex items-center justify-between gap-4">
			<label for="search-default-maxresults" class="text-sm font-medium text-[var(--color-text-primary)]">
				Default max results
			</label>
			<input
				id="search-default-maxresults"
				type="number"
				min="1"
				data-testid="search-default-maxresults"
				bind:value={defaults.maxResults}
				onchange={commitMaxResults}
				disabled={flash.saving}
				class="w-28 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
		</div>

		<!-- defaultProviders -->
		<div class="flex items-center justify-between gap-4">
			<label for="search-default-providers" class="text-sm font-medium text-[var(--color-text-primary)]">
				Allowed providers
			</label>
			<input
				id="search-default-providers"
				type="text"
				placeholder="all"
				data-testid="search-default-providers"
				bind:value={defaults.providers}
				onchange={commitProviders}
				disabled={flash.saving}
				class="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
		</div>

		<div class="flex justify-end">
			<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
		</div>
	</div>
</SettingsSection>
