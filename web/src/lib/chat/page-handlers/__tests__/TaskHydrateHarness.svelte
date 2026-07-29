<script lang="ts">
	/**
	 * Test harness for `attachTaskHydration` — pure `$effect` wiring, so it
	 * only runs inside a real rune scope. Mirrors the chat page's host: the
	 * page passes `convId` and lets everything else default to the store.
	 *
	 * Same pattern as `StreamResumeHarness.svelte`.
	 */
	import { attachTaskHydration } from "../task-hydrate.svelte.js";
	import type { TaskSnapshotResponse } from "../task-hydrate.js";

	interface Props {
		convId?: string;
		/** Injected transport so the test controls timing and payloads. */
		fetchImpl?: typeof fetch;
		/** Surfaced so the test can assert what the effect wrote. */
		onapply?: (convId: string, payload: TaskSnapshotResponse, seq: number) => void;
	}

	let { convId = "conv-1", fetchImpl, onapply }: Props = $props();

	attachTaskHydration({
		convId: () => convId,
		// Read the prop lazily inside the call so swapping it between
		// renders is picked up without capturing an initial value.
		fetchImpl: ((...args: Parameters<typeof fetch>) =>
			(fetchImpl ?? fetch)(...args)) as typeof fetch,
		apply: (cid, payload, seq) => onapply?.(cid, payload, seq),
		seqFor: () => 0,
	});
</script>

<div data-testid="conv">{convId}</div>
