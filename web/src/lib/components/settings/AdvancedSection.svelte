<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";

	let {
		showObservability = $bindable(),
		agentAutonomyEnabled = $bindable(),
	}: {
		showObservability: boolean;
		agentAutonomyEnabled: boolean;
	} = $props();

	let savingObs = $state(false);
	let savingAutonomy = $state(false);

	async function toggleObservability() {
		savingObs = true;
		showObservability = !showObservability;
		try { await upsertSetting("global:showObservability", showObservability); }
		finally { savingObs = false; }
	}

	async function toggleAgentAutonomy() {
		savingAutonomy = true;
		agentAutonomyEnabled = !agentAutonomyEnabled;
		try { await upsertSetting("global:agentAutonomyEnabled", agentAutonomyEnabled); }
		finally { savingAutonomy = false; }
	}
</script>

<SettingsSection
	id="advanced"
	title="Advanced"
	tooltip="Advanced settings for debugging and development. These control optional features that expose additional internal information in the UI."
	description="Advanced features and debugging tools."
>
	<div class="flex items-center justify-between">
		<div>
			<p class="text-sm text-[var(--color-text-primary)] flex items-center gap-2">Show Observability <InfoTooltip text="When enabled, an 'Inspect' button appears on chat messages showing tool call traces, token usage, latency, and provider details. Useful for debugging and understanding how the AI processes requests. No effect on AI behavior." /></p>
			<p class="text-xs text-[var(--color-text-secondary)]">Display the inspect button in chat for tool call traces and token usage.</p>
		</div>
		<button
			onclick={toggleObservability}
			disabled={savingObs}
			class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {showObservability ? 'bg-blue-600' : 'bg-gray-600'}"
			role="switch"
			aria-checked={showObservability}
			aria-label="Toggle observability"
		>
			<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {showObservability ? 'translate-x-5' : 'translate-x-0'}"></span>
		</button>
	</div>
	<div class="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-4">
		<div>
			<p class="text-sm text-[var(--color-text-primary)] flex items-center gap-2">Agent goal pinning &amp; autonomous continuation <InfoTooltip text="When enabled, spawned sub-agents get their objective pinned into the system prompt every cycle and may opt into self-continuation (re-prompting themselves until done). Turn OFF to revert agents to the prior one-shot behavior — no pinned objective, no autonomous looping, regardless of any per-task opt-in." /></p>
			<p class="text-xs text-[var(--color-text-secondary)]">Off reverts spawned agents to the prior one-shot behavior across all task/agent spawns.</p>
		</div>
		<button
			onclick={toggleAgentAutonomy}
			disabled={savingAutonomy}
			class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {agentAutonomyEnabled ? 'bg-blue-600' : 'bg-gray-600'}"
			role="switch"
			aria-checked={agentAutonomyEnabled}
			aria-label="Toggle agent goal pinning and autonomous continuation"
			data-testid="toggle-agent-autonomy"
		>
			<span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {agentAutonomyEnabled ? 'translate-x-5' : 'translate-x-0'}"></span>
		</button>
	</div>
</SettingsSection>
