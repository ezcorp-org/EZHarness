<script lang="ts">
	import { attachPanelPersistence } from "../panel-persistence.svelte.js";

	interface Props {
		convId?: string;
		onstate?: (state: { obsOpen: boolean; persisted: boolean }) => void;
	}
	let { convId = "conv-1", onstate }: Props = $props();
	let obsOpen = $state(false);
	let diffPanelOpen = $state(false);
	let toolsOpen = $state(false);
	let settingsOpen = $state(false);
	let taskLogsOpen = $state(false);
	let taskLogsTask = $state<any>(null);
	let agentDetailId = $state<string | null>(null);
	let selectedAgent = $state<any>(null);

	attachPanelPersistence({
		convId: () => convId,
		searchParams: () => new URLSearchParams(),
		settingsOpen: { get: () => settingsOpen, set: (v) => { settingsOpen = v; } },
		obsOpen: { get: () => obsOpen, set: (v) => { obsOpen = v; } },
		diffPanelOpen: { get: () => diffPanelOpen, set: (v) => { diffPanelOpen = v; } },
		toolsOpen: { get: () => toolsOpen, set: (v) => { toolsOpen = v; } },
		taskLogsOpen: { get: () => taskLogsOpen, set: (v) => { taskLogsOpen = v; } },
		taskLogsTask: { get: () => taskLogsTask, set: (v) => { taskLogsTask = v; } },
		agentDetailId: { get: () => agentDetailId, set: (v) => { agentDetailId = v; } },
		selectedAgent: { get: () => selectedAgent, set: (v) => { selectedAgent = v; } },
		taskSnapshot: () => null,
		subConversations: () => [],
		assignmentForSubConvo: () => undefined,
		streamingAgentCalls: () => ({}),
		onConvSwitch: () => {},
	});

	$effect(() => onstate?.({ obsOpen, persisted: taskLogsOpen }));
</script>

<div data-testid="obs">{obsOpen ? "open" : "closed"}</div>
