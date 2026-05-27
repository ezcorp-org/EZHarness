<script lang="ts" module>
	/**
	 * `◎ /goal active|paused` chip rendered in `ChatHeader.svelte`
	 * (PRD §5.9, FR-20). Subscribes to the global `goal:update` window
	 * CustomEvent re-dispatched by `stores.svelte.ts` (Phase 2 Chunk A);
	 * initial state hydrated via `GET /api/conversations/[id]/goal-state`
	 * on mount so the chip surfaces immediately on page load /
	 * navigation, before any SSE frame has arrived.
	 *
	 * Visually distinct from `AssignmentPill.svelte`'s sub-agent
	 * autonomous-continuation `↻ n/m` cycle counter (PRD §5.9: the two
	 * autopilot indicators MUST remain visually + structurally distinct
	 * so QA never conflates a sub-agent loop with a main-conversation
	 * `/goal`). GoalPill is its own component on its own surface (the
	 * chat header), uses elapsed time rather than an n/m counter, and
	 * carries the `◎` glyph + `goal-pill` testid.
	 *
	 * Click behavior (PRD §5.2 / §5.9): clicking the chip POSTs `/goal`
	 * (no-arg) to the messages route. The slash-prefix interceptor
	 * already handles that as a status request and returns a status
	 * card row (no LLM turn). The card renders inline in the
	 * transcript via the standard `ez-action-result` branch — no new
	 * UI primitive needed. We do NOT navigate or open a panel.
	 *
	 * Lifecycle:
	 *   - on mount: fetch /goal-state. If `state === "off"`, the chip
	 *     stays hidden. Else render with whatever fields the endpoint
	 *     returned (may be partial — `armedAt` is undefined after a
	 *     restart before the in-memory record is rebuilt).
	 *   - on `goal:update` window event: if the payload's
	 *     `conversationId` matches our `convId` prop, replace local
	 *     state with the new payload (defense-in-depth filter: the
	 *     server-side SSE filter already scoped by conv, but a stale
	 *     SSE connection across navigation can briefly deliver another
	 *     conversation's frame).
	 *   - tick: every 1000ms while active, re-derive elapsed string.
	 *     The tick is `setInterval`-driven and stopped on destroy.
	 */

	/** Internal state shape mirroring `/api/.../goal-state` response. */
	export interface GoalPillState {
		state: "active" | "paused" | "off";
		condition?: string;
		armedAt?: number;
		turnsEvaluated?: number;
		lastReason?: string | null;
	}
</script>

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { userFetch } from "$lib/utils/fetch-policy.js";
	import { formatDuration } from "$lib/format-duration.js";

	interface Props {
		convId: string;
		onstatus?: () => void;
	}

	let { convId, onstatus }: Props = $props();

	let pill: GoalPillState = $state({ state: "off" });
	let now = $state(Date.now());
	let tickHandle: ReturnType<typeof setInterval> | null = null;

	/** Live elapsed string for the active state. Returns null for any
	 *  state that should not show a timer (paused / off / no armedAt). */
	let elapsed = $derived.by(() => {
		if (pill.state !== "active") return null;
		if (typeof pill.armedAt !== "number") return null;
		return formatDuration(Math.max(0, now - pill.armedAt));
	});

	/** Whether the chip is rendered at all. Off ⇒ nothing in the DOM. */
	let visible = $derived(pill.state === "active" || pill.state === "paused");

	function applyUpdate(payload: unknown) {
		// Defense in depth: server-side `shouldDeliverEvent` already
		// scoped by conversationId, but a stale SSE connection
		// surviving page navigation could briefly deliver another
		// conversation's frame. Drop anything not addressed to us.
		const p = payload as { conversationId?: unknown } | null;
		if (!p || typeof p !== "object") return;
		if (p.conversationId !== convId) return;

		const next: GoalPillState = {
			state: (p as { state?: GoalPillState["state"] }).state ?? "off",
		};
		const cond = (p as { condition?: unknown }).condition;
		if (typeof cond === "string") next.condition = cond;
		const armedAt = (p as { armedAt?: unknown }).armedAt;
		if (typeof armedAt === "number") next.armedAt = armedAt;
		const turns = (p as { turnsEvaluated?: unknown }).turnsEvaluated;
		if (typeof turns === "number") next.turnsEvaluated = turns;
		const reason = (p as { lastReason?: unknown }).lastReason;
		if (typeof reason === "string" || reason === null) next.lastReason = reason;
		pill = next;
	}

	function onSseGoalUpdate(ev: Event) {
		const ce = ev as CustomEvent<unknown>;
		applyUpdate(ce.detail);
	}

	async function fetchInitial() {
		try {
			const res = await userFetch(`/api/conversations/${convId}/goal-state`);
			if (!res.ok) return;
			const data = (await res.json()) as GoalPillState;
			// Initial state from a server snapshot — apply directly
			// (the response is the chip-shaped projection, not a
			// goal:update event payload).
			pill = data;
		} catch {
			// Network errors are silent — the chip degrades to "off"
			// (its default). The SSE stream will paint it correctly
			// on the next state transition.
		}
	}

	function handleClick() {
		// PRD §5.9: clicking the chip opens the status view. The
		// simplest path that matches existing patterns is for the
		// host page to dispatch the equivalent of a `/goal` (no arg)
		// message — wired via the `onstatus` callback so the parent
		// owns the actual POST (gives the test harness a clean seam
		// + lets the chat page reuse its existing submit pipeline).
		onstatus?.();
	}

	onMount(() => {
		// Subscribe to the re-dispatched SSE event. This pattern
		// mirrors EzPanel (`ez:client-tool`) and the Extensions
		// Library page (`extensions:installed`) — keeps the chip
		// off the second-EventSource path.
		window.addEventListener("goal:update", onSseGoalUpdate);
		tickHandle = setInterval(() => {
			now = Date.now();
		}, 1000);
		fetchInitial();
	});

	onDestroy(() => {
		// Svelte 5's server renderer invokes onDestroy during SSR teardown,
		// where `window` is undefined — guard so it doesn't crash the page's
		// server render (the addEventListener in onMount is client-only).
		if (typeof window !== "undefined") {
			window.removeEventListener("goal:update", onSseGoalUpdate);
		}
		if (tickHandle !== null) {
			clearInterval(tickHandle);
			tickHandle = null;
		}
	});
</script>

{#if visible}
	<button
		type="button"
		class="goal-pill"
		class:goal-pill--active={pill.state === "active"}
		class:goal-pill--paused={pill.state === "paused"}
		data-testid="goal-pill"
		data-state={pill.state}
		title={pill.condition ? `/goal: ${pill.condition}` : "/goal status"}
		aria-label={pill.state === "active" ? "Goal active" : "Goal paused"}
		onclick={handleClick}
	>
		<span class="goal-pill__glyph" aria-hidden="true">◎</span>
		<span class="goal-pill__label">/goal {pill.state}</span>
		{#if elapsed}
			<span class="goal-pill__elapsed tabular-nums" data-testid="goal-pill-elapsed"
				>· {elapsed}</span
			>
		{/if}
	</button>
{/if}

<style>
	.goal-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem 0.55rem;
		border-radius: 9999px;
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		color: var(--color-text-secondary);
		font-size: 0.7rem;
		font-weight: 500;
		line-height: 1.1;
		cursor: pointer;
		transition: filter 0.15s, border-color 0.15s;
	}
	.goal-pill:hover {
		filter: brightness(1.1);
	}
	.goal-pill:focus-visible {
		outline: 2px solid rgb(14 165 233);
		outline-offset: 2px;
	}
	.goal-pill--active {
		/* sky-500 accent — distinct from AssignmentPill's per-agent
		   color and from the autonomous-cycle blue text. */
		border-color: rgb(14 165 233);
		color: rgb(14 165 233);
	}
	.goal-pill--paused {
		/* amber-500 accent — paused warrants attention without
		   alarming as an error would. */
		border-color: rgb(245 158 11);
		color: rgb(245 158 11);
	}
	.goal-pill__glyph {
		font-size: 0.85rem;
		line-height: 1;
	}
	.goal-pill__elapsed {
		opacity: 0.85;
	}
</style>
