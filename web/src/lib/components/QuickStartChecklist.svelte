<script lang="ts">
	import { store } from "$lib/stores.svelte.js";

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

	// Server-side completion state (fetched on mount)
	let apiSteps = $state<{ provider: boolean; chat: boolean; extension: boolean; agent: boolean } | null>(null);

	// Live store fallback: provider updates immediately when user adds one in current session
	let hasProviderFromStore = $derived(
		Object.keys(store.settings).some(
			(k) => k.startsWith("provider:") && k.includes(":apiKey") || k.startsWith("provider:oauth:"),
		),
	);
	let hasAgentsFromStore = $derived(store.agentConfigs.length > 0);

	// Merged completion: API data OR live store (whichever is true)
	let hasProvider = $derived((apiSteps?.provider ?? false) || hasProviderFromStore);
	let hasConversations = $derived(apiSteps?.chat ?? false);
	let hasExtensions = $derived(apiSteps?.extension ?? false);
	let hasAgents = $derived((apiSteps?.agent ?? false) || hasAgentsFromStore);

	interface Step {
		id: string;
		label: string;
		done: boolean;
		href: string;
	}

	let steps = $derived<Step[]>([
		{ id: "provider", label: "Set up a provider", done: hasProvider, href: "/settings" },
		{ id: "chat", label: "Start your first chat", done: hasConversations, href: `/project/${store.activeProjectId}/chat` },
		{ id: "extension", label: "Install an extension", done: hasExtensions, href: "/marketplace" },
		{ id: "agent", label: "Create an agent", done: hasAgents, href: "/agents/new" },
	]);

	let progress = $derived(steps.filter((s) => s.done).length);
	let allDone = $derived(progress === steps.length);

	// Fetch completion from server on mount
	$effect(() => {
		fetch("/api/quickstart")
			.then((r) => {
				if (r.ok) return r.json();
				return null;
			})
			.then((data) => {
				if (data?.steps) apiSteps = data.steps;
			})
			.catch(() => {});
	});

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
					<a
						href={step.href}
						class="flex items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-[var(--color-surface)] group"
					>
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
						<svg class="h-3 w-3 ml-auto shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
						</svg>
					</a>
				{/each}
			</div>
		{/if}
	</div>
{/if}
