<script lang="ts">
	import { upsertSetting, fetchSettings } from "$lib/api.js";

	// Rate limit categories matching hooks.server.ts RATE_LIMITED_ROUTES
	const RATE_CATEGORIES = [
		{ key: "login", label: "Login", default: 5 },
		{ key: "chat", label: "Chat Messages", default: 20 },
		{ key: "agentRun", label: "Agent Runs", default: 10 },
		{ key: "agentGen", label: "Agent Generation", default: 5 },
		{ key: "pipeline", label: "Pipeline Runs", default: 10 },
	] as const;

	const STORAGE_QUOTAS = [
		{ key: "maxConversations", label: "Conversations", default: 500 },
		{ key: "maxMemories", label: "Memories", default: 10_000 },
		{ key: "maxKnowledgeBase", label: "Knowledge Base Entries", default: 100 },
	] as const;

	let rateLimits = $state<Record<string, number>>({});
	let dailyTokens = $state(100_000);
	let quotas = $state<Record<string, number>>({});
	let saving = $state(false);
	let loading = $state(true);

	async function loadSettings() {
		loading = true;
		try {
			const settings = await fetchSettings();
			const rl = (settings["limits:rateLimit"] ?? {}) as Record<string, number>;
			rateLimits = {};
			for (const cat of RATE_CATEGORIES) {
				rateLimits[cat.key] = rl[cat.key] ?? cat.default;
			}
			dailyTokens = (settings["limits:dailyTokens"] as number) ?? 100_000;
			quotas = {};
			for (const q of STORAGE_QUOTAS) {
				quotas[q.key] = (settings[`limits:${q.key}`] as number) ?? q.default;
			}
		} catch { /* silent */ }
		loading = false;
	}

	async function saveAll() {
		saving = true;
		try {
			await upsertSetting("limits:rateLimit", rateLimits);
			await upsertSetting("limits:dailyTokens", dailyTokens);
			for (const q of STORAGE_QUOTAS) {
				await upsertSetting(`limits:${q.key}`, quotas[q.key]);
			}
		} catch { /* silent */ }
		saving = false;
	}

	$effect(() => { loadSettings(); });
</script>

{#if loading}
	<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
{:else}
	<div class="space-y-5">
		<!-- Rate Limits -->
		<div>
			<h4 class="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Rate Limits (requests/min)</h4>
			<div class="grid grid-cols-2 gap-3">
				{#each RATE_CATEGORIES as cat}
					<div>
						<label for="security-rate-{cat.key}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">{cat.label}</label>
						<input
							id="security-rate-{cat.key}"
							type="number"
							min="1"
							bind:value={rateLimits[cat.key]}
							class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
						/>
					</div>
				{/each}
			</div>
		</div>

		<!-- Token Budget -->
		<div>
			<h4 class="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Daily Token Budget</h4>
			<div class="max-w-xs">
				<input
					type="number"
					min="1000"
					step="1000"
					bind:value={dailyTokens}
					class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
				<p class="mt-1 text-xs text-[var(--color-text-muted)]">Per-user daily token limit across all LLM calls</p>
			</div>
		</div>

		<!-- Storage Quotas -->
		<div>
			<h4 class="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Storage Quotas (per user)</h4>
			<div class="grid grid-cols-2 gap-3">
				{#each STORAGE_QUOTAS as q}
					<div>
						<label for="security-quota-{q.key}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">{q.label}</label>
						<input
							id="security-quota-{q.key}"
							type="number"
							min="1"
							bind:value={quotas[q.key]}
							class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
						/>
					</div>
				{/each}
			</div>
		</div>

		<button
			onclick={saveAll}
			disabled={saving}
			class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
		>
			{saving ? "Saving..." : "Save Security Settings"}
		</button>
	</div>
{/if}
