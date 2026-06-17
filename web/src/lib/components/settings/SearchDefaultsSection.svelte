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

	// Explicit-save form, consistent with the Search Backend section: edit
	// freely, then Save commits all four `global:search:*` keys in one click.
	// The form IS the pending edit until Save succeeds — no optimistic writes,
	// so a failed save leaves the admin's edits intact to retry. Re-saving is
	// idempotent, so a partial-write failure converges on the next Save.
	async function save() {
		const quota = sanitizeQuota(defaults.quota);
		const maxResults = sanitizeMaxResults(defaults.maxResults);
		const providers = providersFromText(defaults.providers);
		const ok = await flash.run(async () => {
			await upsertSetting(SEARCH_DEFAULT_KEYS.allowedByDefault, defaults.allowedByDefault);
			await upsertSetting(SEARCH_DEFAULT_KEYS.defaultQuota, quota);
			await upsertSetting(SEARCH_DEFAULT_KEYS.defaultMaxResults, maxResults);
			await upsertSetting(SEARCH_DEFAULT_KEYS.defaultProviders, providers);
		});
		if (ok) {
			// Normalize the form to the saved/canonical values.
			defaults = {
				...defaults,
				quota,
				maxResults,
				providers: providers === "all" ? "all" : providers.join(", "),
			};
		}
	}
</script>

<SettingsSection
	id="search-defaults"
	title="Defaults for Extensions"
	tooltip="The instance-wide policy applied to every extension that holds the search capability and inherits (the default). An extension's per-extension override, when set, takes precedence field-by-field. These are a ceiling — a per-user preference can never raise a quota or widen providers."
	description="Set the search policy new and inheriting extensions get, then Save. Changes propagate to every inheriting extension."
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
				onclick={() => (defaults = { ...defaults, allowedByDefault: !defaults.allowedByDefault })}
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
				disabled={flash.saving}
				class="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
		</div>

		<div class="flex items-center justify-end gap-2">
			<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
			<button
				type="button"
				onclick={save}
				disabled={flash.saving}
				data-testid="search-defaults-save"
				class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
			>
				Save
			</button>
		</div>
	</div>
</SettingsSection>
