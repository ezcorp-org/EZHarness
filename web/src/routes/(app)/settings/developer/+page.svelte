<script lang="ts">
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import ApiKeyManager from "$lib/components/settings/ApiKeyManager.svelte";
</script>

<SettingsSection
	id="api-keys"
	title="Developer"
	tooltip="Create API keys for programmatic access. Each key can have specific scopes (read, chat, extensions, admin) to limit what it can access."
	description="Manage API keys for external tools, scripts, and CI pipelines."
>
	<ApiKeyManager />
</SettingsSection>
