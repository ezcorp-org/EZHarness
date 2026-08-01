<script lang="ts">
	/**
	 * Settings → Models: the stale tool-result cap (`compaction:toolResultCap`).
	 *
	 * EZCorp re-sends the whole branch history on every LLM call, so an older
	 * tool result is billed again on every agentic-loop iteration and every later
	 * turn. This caps how much of one is replayed. The NEWEST tool result is
	 * never capped — that is what the agent is reasoning over right now.
	 *
	 * Unlike the sibling single-click sections this one saves on COMMIT (blur or
	 * Enter), not on every keystroke: typing "32000" one digit at a time would
	 * otherwise write a 3-character cap on the way through. The same validator
	 * the settings API enforces runs here first, so a bad value is refused with
	 * the reason inline instead of round-tripping to a 400.
	 */
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import {
		CHARS_PER_TOKEN_ESTIMATE,
		DEFAULT_TOOL_RESULT_CAP,
		TOOL_RESULT_CAP_SETTING_KEY,
		validateToolResultCap,
	} from "$server/runtime/stream-chat/tool-result-cap";

	let { toolResultCap = $bindable() }: { toolResultCap: number } = $props();

	const flash = createSaveFlash();

	let draft = $state(String(toolResultCap));
	/** Why the current draft was refused, or null when it is acceptable. */
	let refusal = $state<string | null>(null);

	function approxTokens(chars: number): string {
		return Math.round(chars / CHARS_PER_TOKEN_ESTIMATE).toLocaleString();
	}

	async function commit() {
		const typed = draft.trim();
		// `Number("")` is 0, which would read as "disable the cap" — a blanked
		// field is a mistake, not a request to switch the cost control off.
		const result = validateToolResultCap(typed === "" ? Number.NaN : Number(typed));
		if (!result.ok) {
			refusal = result.error;
			return;
		}
		refusal = null;
		if (result.cap === toolResultCap) return;
		const previous = toolResultCap;
		toolResultCap = result.cap;
		const ok = await flash.run(() => upsertSetting(TOOL_RESULT_CAP_SETTING_KEY, result.cap));
		if (!ok) {
			// Roll back the optimistic mutation AND the field, so what is on screen
			// is what is stored.
			toolResultCap = previous;
			draft = String(previous);
		}
	}
</script>

<SettingsSection
	id="tool-result-cap"
	title="Older Tool Result Cap"
	tooltip="A tool result is re-sent to the model on every later step of the same conversation, so a huge one is paid for over and over. This bounds how much of an OLDER result is replayed — the head and the tail are kept and the middle is elided. The result the agent just received is never capped."
	description="How much of an older tool result is re-sent on each step. Saves when you leave the field or press Enter."
>
	<div class="flex flex-wrap items-center gap-2">
		<label class="text-sm text-[var(--color-text-secondary)]" for="tool-result-cap-input">
			Keep at most
		</label>
		<input
			id="tool-result-cap-input"
			data-testid="tool-result-cap-input"
			type="number"
			min="0"
			step="1000"
			value={draft}
			oninput={(e) => (draft = e.currentTarget.value)}
			onchange={commit}
			disabled={flash.saving}
			aria-invalid={refusal !== null}
			class="w-32 rounded-md border bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] disabled:opacity-60
				{refusal ? 'border-red-400' : 'border-[var(--color-border)]'}"
		/>
		<span class="text-sm text-[var(--color-text-secondary)]">characters</span>
		<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
	</div>

	{#if refusal}
		<p class="mt-2 text-xs text-red-400" data-testid="tool-result-cap-refusal" role="alert">
			Not saved — {refusal}
		</p>
	{/if}

	<p class="mt-2 text-xs text-[var(--color-text-secondary)]" data-testid="tool-result-cap-effect">
		{#if toolResultCap === 0}
			The cap is off: older tool results are re-sent in full, every step, at full price.
		{:else}
			About {approxTokens(toolResultCap)} tokens of each older tool result survive — roughly half
			from the start, half from the end.
		{/if}
	</p>
	<p class="mt-1 text-xs text-[var(--color-text-muted)]">
		Lower spends less. Too low and an agent loses the file it read or the log it was working from,
		re-runs the tool, and costs more than the cap saved. Default is
		{DEFAULT_TOOL_RESULT_CAP.toLocaleString()} characters; 0 turns it off.
	</p>
</SettingsSection>
