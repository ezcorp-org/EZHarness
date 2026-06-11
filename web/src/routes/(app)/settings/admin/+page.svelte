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
	import { scrollToLocationHash } from "$lib/scroll-to-hash.js";

	let currentUser = $state<CurrentUser | null>(null);
	let pageLoading = $state(true);

	$effect(() => {
		(async () => {
			const user = await requireAdmin();
			if (!user) {
				goto(SETTINGS_DEFAULT_ROUTE, { replaceState: true });
				return;
			}
			currentUser = user;
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
		id="health"
		title="System Health"
		description="Live subsystem status with auto-refresh."
	>
		<SystemHealth />
	</SettingsSection>
{/if}
