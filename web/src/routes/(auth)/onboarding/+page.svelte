<script lang="ts">
	import type { PageData } from "./$types";
	import ProviderSettings from "$lib/components/ProviderSettings.svelte";
	import { upsertSetting } from "$lib/api.js";
	import type { ProviderStatus } from "$lib/api.js";

	let { data }: { data: PageData } = $props();

	let step = $state(1);
	let providerStatuses = $state<ProviderStatus[]>([]);
	let defaultTier = $state<"quality" | "balanced" | "budget">("balanced");
	// Only persist the tier if the user actually interacted with the
	// radios. A blind Continue keeps whatever the existing setting was
	// (or leaves it unset), matching the plan's "Skip = leave unchanged"
	// contract for unselected interactions.
	let tierTouched = $state(false);
	let finishing = $state(false);

	const providerConnected = $derived(
		data.hasProvider
			|| providerStatuses.some((p) => p.hasKey || (p.oauthConnected && !p.oauthExpired)),
	);

	function selectTier(tier: "quality" | "balanced" | "budget") {
		defaultTier = tier;
		tierTouched = true;
	}

	async function next() {
		if (step === 2 && tierTouched) {
			try {
				await upsertSetting("provider:defaultTier", defaultTier);
			} catch {
				// Non-fatal: tier persists on retry from settings page.
			}
		}
		step += 1;
	}

	async function finish() {
		if (finishing) return;
		finishing = true;
		try {
			await fetch("/api/onboarding/complete", { method: "POST" });
		} catch {
			// Network failure must not strand the user on the wizard. The
			// hook gate will catch them on the next page load if the
			// stamp didn't take.
		}
		// Full reload (not goto): forces hooks.server.ts to re-read the
		// fresh onboardedAt stamp and skip the gate cleanly.
		window.location.href = "/";
	}

	function skip() {
		step += 1;
	}
</script>

<svelte:head><title>EZCorp | Welcome</title></svelte:head>

<div class="min-h-screen bg-[var(--color-surface)] px-4 py-8">
	<div class="mx-auto max-w-3xl">
		<header class="mb-8 text-center">
			<img src="/logo.svg" alt="EZCorp" class="mx-auto h-12 w-12 mb-3" />
			<h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Welcome, {data.user.name}</h1>
			<p class="text-[var(--color-text-secondary)] mt-1">A quick 3-step setup to get you chatting.</p>
		</header>

		<ol class="mb-8 flex items-center justify-center gap-2 text-sm" aria-label="Onboarding progress">
			{#each [1, 2, 3] as n}
				<li class="flex items-center gap-2">
					<span
						class="flex h-7 w-7 items-center justify-center rounded-full {step >= n
							? 'bg-blue-600 text-white'
							: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]'}"
						aria-current={step === n ? "step" : undefined}
					>{n}</span>
					{#if n < 3}<span class="h-px w-8 bg-[var(--color-border)]"></span>{/if}
				</li>
			{/each}
		</ol>

		<div class="rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)] p-6">
			{#if step === 1}
				<h2 class="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Connect a provider</h2>
				<p class="text-sm text-[var(--color-text-secondary)] mb-4">
					Pick any LLM provider and paste an API key (or sign in with OAuth). You only need one to get started.
				</p>

				{#if data.hasProvider}
					<div class="rounded-md border border-green-700 bg-green-900/20 p-4 mb-4 text-sm" data-testid="provider-already-connected">
						<span class="font-medium text-green-400">A provider is already connected.</span>
						<span class="text-[var(--color-text-secondary)]"> You can skip ahead.</span>
					</div>
				{/if}

				<ProviderSettings bind:statuses={providerStatuses} />

				<div class="mt-6 flex items-center justify-between">
					<button
						type="button"
						onclick={skip}
						data-testid="onboarding-step1-skip"
						class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
					>Skip for now</button>
					<button
						type="button"
						onclick={next}
						disabled={!providerConnected}
						data-testid="onboarding-step1-continue"
						class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors"
					>Continue</button>
				</div>
			{:else if step === 2}
				<h2 class="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Pick a default tier</h2>
				<p class="text-sm text-[var(--color-text-secondary)] mb-4">
					Pick the trade-off that fits most of your work. You can override per-conversation later.
				</p>

				<div class="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Default model tier">
					{#each [
						{ id: "quality" as const, title: "Quality", desc: "Best answers; slower and pricier." },
						{ id: "balanced" as const, title: "Balanced", desc: "Sensible default." },
						{ id: "budget" as const, title: "Budget", desc: "Fastest and cheapest." },
					] as opt}
						<label
							class="cursor-pointer rounded-md border p-4 transition-colors {defaultTier === opt.id
								? 'border-blue-500 bg-blue-950/20'
								: 'border-[var(--color-border)] hover:border-[var(--color-text-muted)]'}"
						>
							<input
								type="radio"
								name="default-tier"
								value={opt.id}
								checked={defaultTier === opt.id}
								onchange={() => selectTier(opt.id)}
								class="sr-only"
								data-testid="tier-{opt.id}"
							/>
							<span class="block font-medium text-[var(--color-text-primary)]">{opt.title}</span>
							<span class="block text-xs text-[var(--color-text-secondary)] mt-1">{opt.desc}</span>
						</label>
					{/each}
				</div>

				<div class="mt-6 flex items-center justify-between">
					<button
						type="button"
						onclick={skip}
						data-testid="onboarding-step2-skip"
						class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
					>Skip</button>
					<button
						type="button"
						onclick={next}
						data-testid="onboarding-step2-continue"
						class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-md transition-colors"
					>Continue</button>
				</div>
			{:else}
				<h2 class="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Three keystrokes to know</h2>
				<p class="text-sm text-[var(--color-text-secondary)] mb-4">
					The composer recognizes these mention sigils anywhere in your message.
				</p>

				<div class="grid gap-3 sm:grid-cols-3">
					<div class="rounded-md border border-[var(--color-border)] p-4">
						<span class="block text-2xl font-mono text-blue-400">@</span>
						<span class="block font-medium mt-1 text-[var(--color-text-primary)]">Reference files</span>
						<span class="block text-xs text-[var(--color-text-secondary)] mt-1">
							Project files and folders. Try <code>@README.md</code>
						</span>
					</div>
					<div class="rounded-md border border-[var(--color-border)] p-4">
						<span class="block text-2xl font-mono text-purple-400">!</span>
						<span class="block font-medium mt-1 text-[var(--color-text-primary)]">Run agents</span>
						<span class="block text-xs text-[var(--color-text-secondary)] mt-1">
							Agents, extensions, and teams. Try <code>!research</code>
						</span>
					</div>
					<div class="rounded-md border border-[var(--color-border)] p-4">
						<span class="block text-2xl font-mono text-amber-400">/</span>
						<span class="block font-medium mt-1 text-[var(--color-text-primary)]">Slash commands</span>
						<span class="block text-xs text-[var(--color-text-secondary)] mt-1">
							Commands from <code>.claude</code> or <code>.codex</code>. Try <code>/review</code>
						</span>
					</div>
				</div>

				<p class="mt-4 text-xs text-[var(--color-text-muted)]">
					See the full <a href="/docs#cat-mentions" class="underline">mention grammar</a> when you're ready.
				</p>

				<div class="mt-6 flex items-center justify-end">
					<button
						type="button"
						onclick={finish}
						disabled={finishing}
						data-testid="onboarding-finish"
						class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors"
					>{finishing ? "Finishing..." : "Get started"}</button>
				</div>
			{/if}
		</div>
	</div>
</div>
