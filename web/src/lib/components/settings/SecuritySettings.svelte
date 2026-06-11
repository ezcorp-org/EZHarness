<script lang="ts">
	import { onMount } from "svelte";
	import { upsertSetting, fetchSettings } from "$lib/api.js";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";

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
	let authorAutoModifiable = $state(false);
	let loading = $state(true);

	// Multi-field form (settings UX overhaul, locked decision 5):
	// explicit Save disabled until dirty against the loaded baseline.
	let baseline = $state("");
	const snapshot = () => JSON.stringify({ rateLimits, dailyTokens, quotas, authorAutoModifiable });
	const dirty = $derived(snapshot() !== baseline);
	const flash = createSaveFlash();

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
			authorAutoModifiable = (settings["extensions:authorAutoModifiable"] as boolean) === true;
		} catch { /* silent */ }
		baseline = snapshot();
		loading = false;
	}

	async function saveAll() {
		try {
			await flash.run(async () => {
				await upsertSetting("limits:rateLimit", rateLimits);
				await upsertSetting("limits:dailyTokens", dailyTokens);
				for (const q of STORAGE_QUOTAS) {
					await upsertSetting(`limits:${q.key}`, quotas[q.key]);
				}
				await upsertSetting("extensions:authorAutoModifiable", authorAutoModifiable);
			});
			// Only mark clean when the save actually landed.
			baseline = snapshot();
		} catch { /* silent — matches prior behavior */ }
	}

	onMount(() => { loadSettings(); });
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

		<!-- Extension Authoring -->
		<div>
			<h4 class="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Extension Authoring</h4>
			<label class="flex items-start gap-2">
				<input
					id="security-author-auto-modifiable"
					type="checkbox"
					bind:checked={authorAutoModifiable}
					class="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-accent)] focus:outline-none"
				/>
				<span class="text-xs text-[var(--color-text-secondary)]">
					Auto-allow re-opening user-authored extensions
					<span class="mt-1 block text-[var(--color-text-muted)]">
						When on, an extension a user scaffolds via the in-chat assistant is created
						already flagged modifiable, so they can ask the assistant to edit it without a
						per-extension admin approval. The assistant still requires explicit per-call
						user consent and can never modify silently. Off by default; affects newly
						authored extensions only (no change to existing ones).
					</span>
				</span>
			</label>
		</div>

		<div class="flex items-center gap-3">
			<button
				onclick={saveAll}
				disabled={!dirty || flash.saving}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
			>
				{flash.saving ? "Saving..." : "Save Security Settings"}
			</button>
			<SaveIndicator saved={flash.saved} />
		</div>
	</div>
{/if}
