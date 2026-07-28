<script lang="ts">
	/**
	 * Test harness for `attachStreamResume`. That function is pure `$effect`
	 * wiring — the WS-reconnect resume plus the zombie/staleness watchdog
	 * timers — so it can only run inside a real rune scope. Mirrors the chat
	 * page's host wiring closely enough that the effects see the same
	 * reactive reads (`store.connected`, `activeRunId`, `isStreaming`) and
	 * schedule the same timers.
	 *
	 * Same pattern as `UseSelectModeHarness.svelte`.
	 */
	import { untrack } from "svelte";
	import { attachStreamResume } from "../stream-resume.svelte.js";
	import type { Message } from "$lib/api.js";

	interface Props {
		/** Reactive-ish inputs the effects read. */
		activeRunId?: string | null;
		isStreaming?: boolean;
		resumedRun?: boolean;
		streamingText?: string;
		initialLoadDone?: boolean;
		/** Injectable clock so the reconnect cooldown is deterministic. */
		now?: () => number;
		/** Surfaced so the test can assert the effects' writes. */
		onstate?: (s: { serverStalenessMs: number | null; activeRunStartedAt: number | null }) => void;
	}

	let {
		activeRunId = null,
		isStreaming = false,
		resumedRun = false,
		streamingText = "",
		initialLoadDone = true,
		now = () => 0,
		onstate,
	}: Props = $props();

	// Seeded from props ONCE — `untrack` documents that these are initial
	// values the effects then own, not derived state.
	let runId = $state<string | null>(untrack(() => activeRunId));
	let startedAt = $state<number | null>(null);
	let staleness = $state<number | null>(null);
	let resumed = $state(untrack(() => resumedRun));
	let checking = $state(false);
	let messages = $state<Message[]>([]);
	let leafId = $state<string | null>(null);

	$effect(() => {
		onstate?.({ serverStalenessMs: staleness, activeRunStartedAt: startedAt });
	});

	const api = attachStreamResume(
		{
			convId: () => "conv-1",
			loadGeneration: () => 1,
			initialLoadDone: () => initialLoadDone,
			selectedModel: () => ({ provider: "anthropic", model: "claude-sonnet-5" }),
			activeRunId: { get: () => runId, set: (v) => { runId = v; } },
			activeRunStartedAt: { get: () => startedAt, set: (v) => { startedAt = v; } },
			serverStalenessMs: { get: () => staleness, set: (v) => { staleness = v; } },
			resumedRun: { get: () => resumed, set: (v) => { resumed = v; } },
			checkingActiveRun: { get: () => checking, set: (v) => { checking = v; } },
			allMessages: { get: () => messages, set: (v) => { messages = v; } },
			activeLeafId: { get: () => leafId, set: (v) => { leafId = v; } },
			loadMessages: async () => {},
			makeOptimisticMessage: (o) => ({ id: "", role: "assistant", content: "", ...o }) as Message,
			currentStreamingText: () => streamingText,
			isStreaming: () => isStreaming,
		},
		{ now: untrack(() => now) },
	);

	// Exposed so the test can drive the page's manual entrypoint too.
	export function checkActiveRun(gen: number) {
		return api.checkActiveRun(gen);
	}
</script>

<div data-testid="active-run">{runId ?? "none"}</div>
<div data-testid="staleness">{staleness ?? "null"}</div>
