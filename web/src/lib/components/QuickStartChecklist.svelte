<script lang="ts">
	import { providerAccess } from "$lib/provider-access.js";
	import { store } from "$lib/stores.svelte.js";

	let { role }: { role?: string } = $props();

	const QUICKSTART_KEY = "pi-quickstart";

	// Persistence (dismiss only — completion comes from server)
	function loadDismissed(): boolean {
		try {
			const raw = localStorage.getItem(QUICKSTART_KEY);
			if (!raw) return false;
			const state: { dismissed: boolean } = JSON.parse(raw);
			return state.dismissed === true;
		} catch {
			return false;
		}
	}

	let dismissed = $state(typeof localStorage !== "undefined" ? loadDismissed() : false);
	let collapsed = $state(false);

	// Provider creds aren't in `store.settings` (deny-listed), so that
	// signal must come from `/api/quickstart`; agents do live in the
	// store, so we can fall back to a live derived signal there.
	let hasAgentsFromStore = $derived(store.agentConfigs.length > 0);

	let hasProvider = $derived(store.quickstartSteps?.provider ?? false);
	let hasConversations = $derived(store.quickstartSteps?.chat ?? false);
	let hasExtensions = $derived(store.quickstartSteps?.extension ?? false);
	let hasAgents = $derived((store.quickstartSteps?.agent ?? false) || hasAgentsFromStore);
	let canConfigureProvider = $derived(providerAccess(role).canConfigure);

	interface Step {
		id: string;
		label: string;
		done: boolean;
		href?: string;
	}

	let steps = $derived<Step[]>([
		{
			id: "provider",
			label: canConfigureProvider ? "Set up a provider" : hasProvider ? "Provider ready" : "Ask an admin to connect a provider",
			done: hasProvider,
			href: canConfigureProvider ? "/settings/models#providers" : undefined,
		},
		{ id: "chat", label: "Start your first chat", done: hasConversations, href: `/project/${store.activeProjectId}/chat` },
		{ id: "extension", label: "Install an extension", done: hasExtensions, href: "/marketplace" },
		{ id: "agent", label: "Create an agent", done: hasAgents, href: "/agents/new" },
	]);

	let progress = $derived(steps.filter((s) => s.done).length);
	let allDone = $derived(progress === steps.length);

	// Auto-dismiss when all steps complete
	$effect(() => {
		if (allDone && !dismissed) {
			dismissed = true;
		}
	});

	// Persist dismissed state
	$effect(() => {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(QUICKSTART_KEY, JSON.stringify({ dismissed }));
		}
	});

	function dismiss() {
		dismissed = true;
	}
</script>

{#if !dismissed}
	<div class="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-3">
		<!-- Header -->
		<div class="flex items-center justify-between mb-2">
			<button
				onclick={() => (collapsed = !collapsed)}
				class="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)]"
			>
				<svg
					class="h-3 w-3 transition-transform {collapsed ? '-rotate-90' : ''}"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
				</svg>
				Get Started
				<span class="text-[var(--color-text-muted)] font-normal">{progress}/{steps.length}</span>
			</button>
			{#if progress > 0}
				<button
					onclick={dismiss}
					class="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
					title="Dismiss checklist"
					aria-label="Dismiss checklist"
				>
					<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			{/if}
		</div>

		<!-- Progress bar -->
		<div class="h-1 rounded-full bg-[var(--color-border)] mb-2">
			<div
				class="h-1 rounded-full bg-green-500 transition-all duration-300"
				style="width: {(progress / steps.length) * 100}%"
			></div>
		</div>

		<!-- Steps -->
		{#if !collapsed}
			<div class="flex flex-col gap-1">
				{#each steps as step}
					{#snippet stepContent(step: Step)}
						{#if step.done}
							<svg class="h-3.5 w-3.5 shrink-0 text-green-500" fill="currentColor" viewBox="0 0 24 24">
								<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
							</svg>
						{:else}
							<svg class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<circle cx="12" cy="12" r="10" stroke-width="2" />
							</svg>
						{/if}
						<span class="{step.done ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text-secondary)]'}">
							{step.label}
						</span>
						{#if step.href}
							<svg class="h-3 w-3 ml-auto shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
							</svg>
						{/if}
					{/snippet}
					{#if step.href}
						<a
							href={step.href}
							class="flex items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-[var(--color-surface)] group"
						>
							{@render stepContent(step)}
						</a>
					{:else}
						<div class="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
							{@render stepContent(step)}
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
{/if}
