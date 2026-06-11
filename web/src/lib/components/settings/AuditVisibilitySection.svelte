<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";

	let {
		showBuiltinPills = $bindable(),
		showInstalledPills = $bindable(),
		eventAuditSampleN = $bindable(),
	}: {
		showBuiltinPills: boolean;
		showInstalledPills: boolean;
		eventAuditSampleN: number;
	} = $props();

	let auditSectionOpen = $state(false);
	const flash = createSaveFlash();

	// Phase 52.5 — Audit & Visibility persistence. Same upsertSetting
	// flow as the existing observability toggle (one round-trip per
	// change; no debounce — settings are admin-only writes anyway).
	async function toggleBuiltinPills() {
		showBuiltinPills = !showBuiltinPills;
		await flash.run(() => upsertSetting("global:showBuiltinCapabilityEvents", showBuiltinPills));
	}
	async function toggleInstalledPills() {
		showInstalledPills = !showInstalledPills;
		await flash.run(() => upsertSetting("global:showInstalledCapabilityEvents", showInstalledPills));
	}
	async function saveEventAuditSampleN(): Promise<void> {
		// Clamp to [1, 10000] — same range the dispatcher enforces
		// server-side in Phase 51.4. Defends against typos like 0
		// (would mean "audit every event" — explicit ON has its own
		// keyword) or negative values.
		const clamped = Math.max(1, Math.min(10000, Math.floor(eventAuditSampleN)));
		eventAuditSampleN = clamped;
		await flash.run(() => upsertSetting("global:eventSubscriptionAuditSampleN", clamped));
	}
</script>

<SettingsSection
	id="audit-visibility"
	title="Audit & Visibility"
	tooltip="Controls which capability events appear inline in chat and how often event-subscription deliveries are audited. The audit trail is always written to the database; these toggles only affect what the UI shows you."
	description="Hide chatty extension pills without losing the audit trail."
	collapsible
	bind:open={auditSectionOpen}
	testid="settings-audit-visibility"
>
	<div class="space-y-4">
		<div class="flex min-h-4 justify-end">
			<SaveIndicator saving={flash.saving} saved={flash.saved} />
		</div>
		<div class="flex items-center justify-between">
			<div>
				<p class="text-sm text-[var(--color-text-primary)]">Show built-in capability events in chat</p>
				<p class="text-xs text-[var(--color-text-muted)]">First-party extensions (lessons-keeper, memory-extractor, …). Default: on.</p>
			</div>
			<button
				onclick={toggleBuiltinPills}
				disabled={flash.saving}
				class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {showBuiltinPills ? 'bg-blue-600' : 'bg-gray-600'}"
				role="switch"
				aria-checked={showBuiltinPills}
				aria-label="Toggle built-in pill visibility"
				data-testid="toggle-builtin-pills"
			>
				<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {showBuiltinPills ? 'translate-x-5' : 'translate-x-0'}"></span>
			</button>
		</div>

		<div class="flex items-center justify-between">
			<div>
				<p class="text-sm text-[var(--color-text-primary)]">Show installed-extension capability events in chat</p>
				<p class="text-xs text-[var(--color-text-muted)]">Third-party extensions you installed yourself. Default: off (they can be chatty).</p>
			</div>
			<button
				onclick={toggleInstalledPills}
				disabled={flash.saving}
				class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {showInstalledPills ? 'bg-blue-600' : 'bg-gray-600'}"
				role="switch"
				aria-checked={showInstalledPills}
				aria-label="Toggle installed-extension pill visibility"
				data-testid="toggle-installed-pills"
			>
				<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {showInstalledPills ? 'translate-x-5' : 'translate-x-0'}"></span>
			</button>
		</div>

		<div class="flex items-center justify-between gap-3">
			<div class="min-w-0 flex-1">
				<p class="text-sm text-[var(--color-text-primary)]">Event-delivery audit sample rate (1-in-N)</p>
				<p class="text-xs text-[var(--color-text-muted)]">Sampled audit rows for ctx.events deliveries. Lower = more rows, higher cost. Range 1–10000.</p>
			</div>
			<input
				type="number"
				min="1"
				max="10000"
				bind:value={eventAuditSampleN}
				onchange={() => saveEventAuditSampleN()}
				class="w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
				data-testid="input-event-audit-sample"
			/>
		</div>
	</div>
</SettingsSection>
