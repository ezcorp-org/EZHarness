<script lang="ts" module>
	/**
	 * Phase 52.5 — in-chat capability event pill.
	 *
	 * Single-line render of a `messages.role = "capability-event"`
	 * row. The row's `content` field carries a JSON sentinel written
	 * by `recordCapabilityCall` (write 3) — this component parses
	 * that sentinel and renders an icon + a verb + a one-line
	 * summary. Click toggles a detail row that fetches the linked
	 * `sdk_capability_calls` row by id (the metadata FK is exactly
	 * `sdkCapabilityCallId`).
	 *
	 * Visual language: same shell as `ExcludedFromContextPill` /
	 * `SelectedPill` — flat, minimal, in-line within the chat
	 * stream so the pill doesn't dominate the turn it's part of.
	 *
	 * The component is intentionally agnostic to visibility — the
	 * page (or ChatMessage parent) decides whether to mount it via
	 * `shouldShowPill` from `$lib/ez/pill-visibility`. This keeps
	 * the pill a pure renderer; the gate is testable without DOM.
	 */
	export interface CapabilityEventPayload {
		__ezcorp_capability_event: true;
		sdkCapabilityCallId: string;
		capability: "llm" | "memory" | "lessons" | "schedule" | "events" | string;
		action: string;
		resourceType?: string | null;
		resourceId?: string | null;
		success?: boolean;
		durationMs?: number;
		costUsd?: number | null;
		model?: string | null;
		provider?: string | null;
		extensionName?: string | null;
	}

	export interface CapabilityPillMessage {
		id: string;
		role: string;
		content: string;
	}

	/** Lenient parse — returns null on malformed input so the
	 *  component can fall back to a tiny "unreadable" pill instead of
	 *  surfacing a server-side bug as a blank message row. */
	export function parseCapabilityEventContent(raw: string): CapabilityEventPayload | null {
		try {
			const parsed = JSON.parse(raw);
			if (
				parsed &&
				typeof parsed === "object" &&
				(parsed as { __ezcorp_capability_event?: unknown }).__ezcorp_capability_event === true &&
				typeof (parsed as { sdkCapabilityCallId?: unknown }).sdkCapabilityCallId === "string" &&
				typeof (parsed as { capability?: unknown }).capability === "string" &&
				typeof (parsed as { action?: unknown }).action === "string"
			) {
				return parsed as CapabilityEventPayload;
			}
			return null;
		} catch {
			return null;
		}
	}
</script>

<script lang="ts">
	interface Props {
		message: CapabilityPillMessage;
		/** Optional extension name for nicer summaries. Falls back
		 *  to "extension" when not supplied. */
		extensionName?: string;
	}

	const { message, extensionName }: Props = $props();

	const payload = $derived(parseCapabilityEventContent(message.content));

	function iconFor(p: CapabilityEventPayload): string {
		if (p.success === false) return "🚫";
		switch (p.capability) {
			case "llm": return "🤖";
			case "memory": return "🧠";
			case "lessons": return "📚";
			case "schedule": return "📅";
			case "events": return "📡";
			default: return "·";
		}
	}

	function verbFor(p: CapabilityEventPayload): string {
		// Map common action strings to user-readable verbs.
		// Falls through to the raw action for anything we don't
		// special-case — keeps the pill resilient to new actions
		// being added without a UI redeploy.
		if (p.success === false) return `denied: ${p.action}`;
		const map: Record<string, string> = {
			complete: "called",
			read: "read",
			write: "wrote",
			update: "updated",
			delete: "deleted",
			search: "searched",
			subscribe: "subscribed to",
			fire: "fired",
			register: "scheduled",
		};
		return map[p.action] ?? p.action;
	}

	function summaryFor(p: CapabilityEventPayload): string {
		const bits: string[] = [];
		if (p.capability === "llm") {
			if (p.model) bits.push(p.model);
			// Token count is not in the pill payload today — pulled
			// from sdkCapabilityCalls on expand.
			if (p.costUsd != null) bits.push(`$${p.costUsd.toFixed(3)}`);
		} else if (p.capability === "memory" || p.capability === "lessons") {
			if (p.resourceType) bits.push(p.resourceType);
			if (p.resourceId) bits.push(p.resourceId.slice(0, 8));
		} else if (p.capability === "schedule") {
			if (p.resourceType) bits.push(p.resourceType);
		}
		if (typeof p.durationMs === "number") bits.push(`${p.durationMs}ms`);
		return bits.join(" · ");
	}

	const name = $derived(extensionName ?? payload?.extensionName ?? "extension");
	let detailOpen = $state(false);
	let detail = $state<Record<string, unknown> | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);

	async function toggleDetail() {
		if (!payload) return;
		detailOpen = !detailOpen;
		if (!detailOpen || detail !== null) return;
		// Fetch the underlying sdk_capability_calls row. The endpoint
		// hangs off the per-extension audit page; we don't have the
		// extensionId on the pill payload (audit faithfulness lives
		// in the row, not the pill), so fall back to the global feed
		// keyed by the FK.
		detailLoading = true;
		try {
			const res = await fetch(
				`/api/audit?search=${encodeURIComponent(payload.sdkCapabilityCallId)}&limit=1`,
			);
			if (!res.ok) throw new Error(`Detail fetch failed: ${res.status}`);
			const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
			detail = body.entries[0] ?? null;
		} catch (e) {
			detailError = e instanceof Error ? e.message : "Detail fetch failed";
		} finally {
			detailLoading = false;
		}
	}
</script>

{#if !payload}
	<div class="px-2 py-1 text-[10px] italic text-rose-400" data-testid="capability-pill-unreadable">
		Capability event unreadable.
	</div>
{:else}
	<div class="space-y-1" data-testid="capability-pill" data-capability={payload.capability} data-success={payload.success !== false}>
		<button
			type="button"
			class="flex w-full items-center gap-2 rounded-md bg-[var(--color-surface-tertiary)] px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--color-border)]"
			onclick={toggleDetail}
			aria-expanded={detailOpen}
		>
			<span aria-hidden="true">{iconFor(payload)}</span>
			<span class="font-medium text-[var(--color-text-primary)]">{name}</span>
			<span class="text-[var(--color-text-secondary)]">{verbFor(payload)}</span>
			<span class="truncate text-[var(--color-text-muted)]">{summaryFor(payload)}</span>
		</button>
		{#if detailOpen}
			<div class="rounded-md bg-[var(--color-surface)] p-2 text-[10px] text-[var(--color-text-secondary)]" data-testid="capability-pill-detail">
				{#if detailLoading}
					Loading…
				{:else if detailError}
					<span class="text-rose-400">{detailError}</span>
				{:else if detail}
					<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(detail, null, 2)}</pre>
				{:else}
					Detail not found (audit row may have been pruned).
				{/if}
			</div>
		{/if}
	</div>
{/if}
