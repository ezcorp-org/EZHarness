<script lang="ts">
	import { goto } from "$app/navigation";
	import { requireAdmin, type CurrentUser } from "$lib/admin-guard.js";
	import { SETTINGS_DEFAULT_ROUTE } from "$lib/settings-nav.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import UsersSection from "$lib/components/settings/UsersSection.svelte";
	import TeamsSection from "$lib/components/settings/TeamsSection.svelte";
	import InvitesSection from "$lib/components/settings/InvitesSection.svelte";
	import SecuritySettings from "$lib/components/settings/SecuritySettings.svelte";
	import SystemHealth from "$lib/components/settings/SystemHealth.svelte";
	import { fetchSettings, upsertSetting } from "$lib/api.js";
	import { scrollToLocationHash } from "$lib/scroll-to-hash.js";

	// The persisted global loops kill switch (src/extensions/loops-kill-switch.ts).
	const LOOPS_KILL_SWITCH_KEY = "loops:kill_switch";
	let killSwitchOn = $state(false);
	let killSwitchLoaded = $state(false);
	let killSwitchBusy = $state(false);
	// Two-step confirm shown only when ENGAGING (the consequential direction —
	// it suspends all automation). Disengaging (resume) applies immediately.
	let confirmEngage = $state(false);

	let currentUser = $state<CurrentUser | null>(null);
	let pageLoading = $state(true);

	async function loadKillSwitch() {
		try {
			const settings = await fetchSettings();
			killSwitchOn = settings[LOOPS_KILL_SWITCH_KEY] === true;
		} catch {
			/* leave default (off) */
		}
		killSwitchLoaded = true;
	}

	async function applyKillSwitch(next: boolean) {
		killSwitchBusy = true;
		try {
			await upsertSetting(LOOPS_KILL_SWITCH_KEY, next);
			killSwitchOn = next;
		} catch {
			/* surface nothing — the toggle reflects the last confirmed state */
		}
		killSwitchBusy = false;
		confirmEngage = false;
	}

	function onKillSwitchClick() {
		if (killSwitchOn) {
			// Currently suspended → resume immediately (safe direction).
			applyKillSwitch(false);
		} else {
			// Currently running → ask before suspending everything.
			confirmEngage = true;
		}
	}

	$effect(() => {
		(async () => {
			const user = await requireAdmin();
			if (!user) {
				goto(SETTINGS_DEFAULT_ROUTE, { replaceState: true });
				return;
			}
			currentUser = user;
			await loadKillSwitch();
			pageLoading = false;
			scrollToLocationHash();
		})();
	});
</script>

{#if pageLoading}
	<SkeletonLoader type="form" />
{:else}
	<UsersSection {currentUser} />
	<TeamsSection />
	<InvitesSection />

	<SettingsSection
		title="Audit Log"
		description="View authentication and sharing events on the dedicated log page."
	>
		{#snippet actions()}
			<a
				href="/settings/admin/audit"
				data-testid="audit-log-link"
				class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
			>
				View Log
			</a>
		{/snippet}
	</SettingsSection>

	<SettingsSection
		id="security"
		title="Security"
		tooltip="Configure rate limits, daily token budgets, and storage quotas. These settings apply globally to all users."
		description="Rate limits, token budgets, and storage quotas."
	>
		<SecuritySettings />
	</SettingsSection>

	<SettingsSection
		id="loops"
		title="Loops Safety"
		tooltip="The global kill switch suspends every scheduled and event-driven loop fire. Runs already parked awaiting your approval are kept — only new fires stop."
		description="Emergency stop for all automated loops."
	>
		<div class="space-y-3" data-testid="loops-kill-switch">
			<p class="text-xs text-[var(--color-text-secondary)]">
				Status:
				<span
					data-testid="loops-kill-switch-status"
					class="font-medium {killSwitchOn ? 'text-red-500' : 'text-green-500'}"
				>
					{killSwitchOn ? "Suspended" : "Running"}
				</span>
			</p>
			{#if confirmEngage}
				<div
					data-testid="loops-kill-switch-confirm"
					class="rounded-md border border-red-500/40 bg-red-500/5 p-3"
				>
					<p class="mb-2 text-xs text-[var(--color-text-secondary)]">
						This suspends ALL scheduled and event-driven loop fires. Parked approvals
						are kept. Continue?
					</p>
					<div class="flex items-center gap-2">
						<button
							data-testid="loops-kill-switch-confirm-yes"
							onclick={() => applyKillSwitch(true)}
							disabled={killSwitchBusy}
							class="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
						>
							{killSwitchBusy ? "Suspending..." : "Suspend all loops"}
						</button>
						<button
							data-testid="loops-kill-switch-confirm-cancel"
							onclick={() => (confirmEngage = false)}
							disabled={killSwitchBusy}
							class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] transition-colors"
						>
							Cancel
						</button>
					</div>
				</div>
			{:else}
				<button
					data-testid="loops-kill-switch-toggle"
					onclick={onKillSwitchClick}
					disabled={!killSwitchLoaded || killSwitchBusy}
					class="rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 transition-colors {killSwitchOn
						? 'bg-green-600 hover:bg-green-500'
						: 'bg-red-600 hover:bg-red-500'}"
				>
					{killSwitchOn ? "Resume loops" : "Suspend all loops"}
				</button>
			{/if}
		</div>
	</SettingsSection>

	<SettingsSection
		id="health"
		title="System Health"
		description="Live subsystem status with auto-refresh."
	>
		<SystemHealth />
	</SettingsSection>
{/if}
