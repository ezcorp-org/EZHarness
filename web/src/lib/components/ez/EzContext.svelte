<script lang="ts">
	/**
	 * Phase 48 Wave 3 — page-level <EzContext> provider.
	 *
	 * Pages render this once to hand the Ez panel a snapshot of what's
	 * on screen + (optionally) form-fill handlers. The component
	 * registers on mount and deregisters on unmount via the registry's
	 * symbol-token contract, so navigation between two instrumented
	 * pages never leaves a stale entry behind.
	 *
	 * Reactivity: when `data` or `forms` change, we deregister the old
	 * token and re-register a fresh one. We use the unmount/remount
	 * shape (rather than mutating the entry in place) because the
	 * registry's identity is the symbol; treating it as immutable
	 * keeps subscribe semantics simple.
	 *
	 * Token-budget warn: emitted by `buildEzContextPayload`, not here.
	 * The warning fires once per send when the *aggregate* of all
	 * mounted entries overflows — that's the spot end users actually
	 * feel pain (LLM context cost), not when an individual provider
	 * mounts.
	 */
	import { onDestroy } from "svelte";
	import { page } from "$app/state";
	import {
		registerContext,
		deregisterContext,
		type FormHandler,
	} from "$lib/ez/registry.js";

	let {
		data = {},
		forms = {},
		routeId,
	}: {
		/** Page-exposed state Ez may read. JSON-serialized into the prompt. */
		data?: Record<string, unknown>;
		/** Form-id keyed handlers for `fill_form` calls. */
		forms?: Record<string, FormHandler>;
		/** Override the auto-detected route id (defaults to `$page.route.id`). */
		routeId?: string;
	} = $props();

	let token: symbol | null = null;

	function register() {
		const id = routeId ?? page.route?.id ?? "";
		token = registerContext({ routeId: id, data, forms });
	}

	function refresh() {
		if (token) deregisterContext(token);
		register();
	}

	// Initial mount + react to prop changes. Svelte 5 runs $effect after
	// mount, so the first run does the initial register; subsequent
	// runs (when `data` / `forms` change) refresh the entry.
	$effect(() => {
		// Touch the props so the effect re-runs when they change.
		void data;
		void forms;
		void routeId;
		refresh();
	});

	onDestroy(() => {
		if (token) deregisterContext(token);
		token = null;
	});
</script>

<!--
	No DOM — this component is a side-effect-only register/deregister
	bridge. Pages compose it like `<EzContext data={...} forms={...} />`.
-->
