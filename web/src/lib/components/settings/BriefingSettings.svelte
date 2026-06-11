<script lang="ts">
	import { onMount } from "svelte";
	import {
		buildBriefingCron,
		parseBriefingCron,
		describeBriefingCron,
		formatRetrySeconds,
		PRESET_LABELS,
		type WeekdayPreset,
	} from "$lib/briefing-cron.js";
	import { relativeTime } from "$lib/utils/relative-time.js";
	import ModelSearchPicker from "$lib/components/ModelSearchPicker.svelte";
	import { CURRENT_MODEL_SENTINEL } from "$lib/api";

	/**
	 * Daily Briefing settings (spec §5.4). Talks to GET/PUT
	 * /api/briefing/config and POST /api/briefing/run-now.
	 *
	 * Schedule editing is preset-based: time-of-day + weekday preset map
	 * to a 5-field cron via $lib/briefing-cron. A cron the UI didn't
	 * write (hand-edited through the API) is shown read-only instead of
	 * being mangled through the pickers.
	 *
	 * Watchlist manager (Phase 3): topics — including ones captured
	 * conversationally via briefing_watch — are listed with remove
	 * buttons (curation floor, spec §4.3). PUT sends `watchlist` ONLY
	 * after the user edits it here, preserving the server's
	 * merge-on-omit semantics for untouched saves. A dirty save
	 * DELTA-MERGES against a fresh GET (added = current − snapshot,
	 * removed = snapshot − current, sent = (fresh − removed) ∪ added)
	 * so a topic captured via briefing_watch between page load and
	 * save is never silently clobbered.
	 */

	type ProjectOption = { id: string; name: string };
	let { projects = [] }: { projects?: ProjectOption[] } = $props();

	type WatchlistEntry = { topic: string; addedAt: string };

	type BriefingConfigResponse = {
		enabled: boolean;
		cron: string;
		timezone: string;
		projectId: string | null;
		instructions: string;
		watchlist?: WatchlistEntry[];
		model: string | null;
		provider: string | null;
		lastFireAt: string | null;
		lastFireStatus: "ok" | "error" | "skipped" | null;
		createdAt?: string;
	};

	// Mirrors MAX_WATCHLIST_TOPICS / MAX_TOPIC_LENGTH in
	// src/runtime/briefing/config-validation.ts (the server enforces
	// them authoritatively on PUT; these only gate the Add button UX —
	// importing the server module into the client bundle isn't worth a
	// shared constant).
	const MAX_TOPICS = 25;
	const MAX_TOPIC_CHARS = 200;

	let loading = $state(true);
	let loadError = $state(false);

	// Form state
	let enabled = $state(false);
	let time = $state("07:00");
	let preset = $state<WeekdayPreset>("daily");
	let timezone = $state("UTC");
	let projectId = $state<string>("");
	let instructions = $state("");
	// Model override — null means "instance default". Uses the app-wide
	// ModelSearchPicker (same component as AgentConfigForm / ChatInput);
	// the picker's "Current Chat Model" sentinel has no meaning for a
	// scheduled run, so selecting it maps back to null here.
	let selectedModel = $state<{ provider: string; model: string } | null>(null);

	// Watchlist manager state. `watchlistDirty` gates whether the PUT
	// body carries the watchlist at all — an untouched save omits it so
	// the server's preserve-on-omit semantics keep working (and a
	// concurrently chat-added topic is never clobbered by an unrelated
	// settings save).
	let watchlist = $state<WatchlistEntry[]>([]);
	let watchlistDirty = $state(false);
	let newTopic = $state("");
	let watchlistError = $state<string | null>(null);
	// GET-time snapshot the dirty-save delta is computed against. Plain
	// (non-reactive) — only read inside save(); entries are never mutated
	// in place, so sharing entry objects with `watchlist` is safe.
	let watchlistSnapshot: WatchlistEntry[] = [];

	// Server-side dedupe is case-insensitive — mirror it for the merge.
	const topicKey = (topic: string) => topic.trim().toLowerCase();

	// Hand-edited cron passthrough (read-only display).
	let rawCron = $state<string | null>(null);

	// Last-run status (server-owned).
	let lastFireAt = $state<string | null>(null);
	let lastFireStatus = $state<"ok" | "error" | "skipped" | null>(null);

	// Save state
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let saveSuccess = $state(false);

	// Run-now state
	let runNowBusy = $state(false);
	let runNowMessage = $state<string | null>(null);
	let runNowError = $state(false);
	let retrySeconds = $state(0);
	let retryTimer: ReturnType<typeof setInterval> | null = null;

	const STATUS_LABELS: Record<string, string> = {
		ok: "delivered",
		error: "failed",
		skipped: "skipped",
	};

	let scheduleDescription = $derived(
		rawCron === null ? describeBriefingCron(buildBriefingCron({ time, preset }) ?? "") : null,
	);

	// IANA zone suggestions for the timezone input (free text still allowed;
	// the server validates via Intl either way).
	let timezoneOptions = $derived.by((): string[] => {
		try {
			return Intl.supportedValuesOf("timeZone");
		} catch {
			return [];
		}
	});

	function applyConfig(config: BriefingConfigResponse) {
		enabled = config.enabled;
		timezone = config.timezone;
		projectId = config.projectId ?? "";
		instructions = config.instructions;
		watchlist = config.watchlist ?? [];
		watchlistSnapshot = config.watchlist ?? [];
		watchlistDirty = false;
		watchlistError = null;
		selectedModel =
			config.model && config.provider
				? { provider: config.provider, model: config.model }
				: null;
		lastFireAt = config.lastFireAt;
		lastFireStatus = config.lastFireStatus;

		const schedule = parseBriefingCron(config.cron);
		if (schedule) {
			time = schedule.time;
			preset = schedule.preset;
			rawCron = null;
		} else {
			rawCron = config.cron;
		}

		// Never-configured users (no stored row → no createdAt) get the
		// browser's timezone as the starting point instead of the UTC
		// server default (spec §5.4).
		if (!config.createdAt) {
			try {
				timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			} catch {
				// keep server default
			}
		}
	}

	async function loadConfig() {
		loading = true;
		loadError = false;
		try {
			const res = await fetch("/api/briefing/config");
			if (!res.ok) throw new Error(`status ${res.status}`);
			applyConfig(await res.json());
		} catch {
			loadError = true;
		} finally {
			loading = false;
		}
	}

	function switchToPicker() {
		// Replace the hand-edited cron with the picker's current values on
		// next save. Until saved, the server still has the raw cron.
		rawCron = null;
	}

	function addWatchlistTopic() {
		watchlistError = null;
		const topic = newTopic.trim();
		if (!topic) return;
		if (topic.length > MAX_TOPIC_CHARS) {
			watchlistError = `Topics are limited to ${MAX_TOPIC_CHARS} characters.`;
			return;
		}
		if (watchlist.length >= MAX_TOPICS) {
			watchlistError = `You can watch at most ${MAX_TOPICS} topics — remove one first.`;
			return;
		}
		if (watchlist.some((w) => w.topic.toLowerCase() === topic.toLowerCase())) {
			watchlistError = `"${topic}" is already on the watchlist.`;
			return;
		}
		watchlist = [...watchlist, { topic, addedAt: new Date().toISOString() }];
		watchlistDirty = true;
		newTopic = "";
	}

	function removeWatchlistTopic(topic: string) {
		watchlistError = null;
		watchlist = watchlist.filter((w) => w.topic !== topic);
		watchlistDirty = true;
	}

	/**
	 * Delta-merge the user's watchlist edits onto the server's CURRENT
	 * list. The UI list is snapshot + edits; sending it wholesale would
	 * clobber a topic added via the briefing_watch chat tool between
	 * page load and save. Instead: added = current − snapshot, removed =
	 * snapshot − current, sent = (fresh − removed) ∪ added, deduped
	 * case-insensitively (matching the server). Falls back to the local
	 * list when the fresh GET fails — identical to the pre-merge
	 * behavior, never worse.
	 */
	async function mergeWatchlistForSave(): Promise<WatchlistEntry[]> {
		const snapshotKeys = new Set(watchlistSnapshot.map((w) => topicKey(w.topic)));
		const currentKeys = new Set(watchlist.map((w) => topicKey(w.topic)));
		const added = watchlist.filter((w) => !snapshotKeys.has(topicKey(w.topic)));
		const removed = new Set(
			watchlistSnapshot
				.filter((w) => !currentKeys.has(topicKey(w.topic)))
				.map((w) => topicKey(w.topic)),
		);

		let fresh = watchlist;
		try {
			const res = await fetch("/api/briefing/config");
			if (res.ok) {
				const config = (await res.json()) as BriefingConfigResponse;
				fresh = config.watchlist ?? [];
			}
		} catch {
			// fall back to the local list (pre-merge behavior)
		}

		const merged = fresh.filter((w) => !removed.has(topicKey(w.topic)));
		const mergedKeys = new Set(merged.map((w) => topicKey(w.topic)));
		for (const entry of added) {
			if (!mergedKeys.has(topicKey(entry.topic))) {
				merged.push(entry);
				mergedKeys.add(topicKey(entry.topic));
			}
		}
		return merged;
	}

	async function save() {
		saving = true;
		saveError = null;
		saveSuccess = false;
		try {
			const cron = rawCron ?? buildBriefingCron({ time, preset });
			if (!cron) {
				saveError = "Pick a valid time of day.";
				return;
			}
			// Only send the watchlist when the user actually edited it here —
			// an omitted key preserves the stored list server-side. A dirty
			// list is delta-merged against the server's current state so
			// concurrently chat-added topics survive this save.
			let mergedWatchlist: WatchlistEntry[] | null = null;
			if (watchlistDirty) {
				mergedWatchlist = await mergeWatchlistForSave();
				if (mergedWatchlist.length > MAX_TOPICS) {
					saveError =
						`The merged watchlist has ${mergedWatchlist.length} topics (topics added from chat count too) ` +
						`— the limit is ${MAX_TOPICS}. Remove some topics and save again.`;
					return;
				}
			}
			const res = await fetch("/api/briefing/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					enabled,
					cron,
					timezone: timezone.trim(),
					projectId: projectId || null,
					instructions,
					...(mergedWatchlist !== null ? { watchlist: mergedWatchlist } : {}),
					model: selectedModel?.model ?? null,
					provider: selectedModel?.provider ?? null,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				saveError = typeof body?.error === "string" ? body.error : "Failed to save briefing settings.";
				return;
			}
			applyConfig(body);
			saveSuccess = true;
		} catch {
			saveError = "Failed to save briefing settings.";
		} finally {
			saving = false;
		}
	}

	function startRetryCountdown(seconds: number) {
		stopRetryCountdown();
		retrySeconds = Math.max(1, Math.ceil(seconds));
		retryTimer = setInterval(() => {
			retrySeconds -= 1;
			if (retrySeconds <= 0) {
				stopRetryCountdown();
				runNowMessage = null;
				runNowError = false;
			}
		}, 1000);
	}

	function stopRetryCountdown() {
		if (retryTimer) {
			clearInterval(retryTimer);
			retryTimer = null;
		}
		retrySeconds = 0;
	}

	async function runNow() {
		// Re-entrancy guard: the button is disabled while busy, but a
		// programmatic/synthetic second click (or a queued event racing the
		// disabled attribute) must never fire a second POST.
		if (runNowBusy) return;
		runNowBusy = true;
		runNowMessage = null;
		runNowError = false;
		try {
			const res = await fetch("/api/briefing/run-now", { method: "POST" });
			if (res.status === 202) {
				runNowMessage = "Briefing started — the new conversation will appear in your sidebar shortly.";
				return;
			}
			const body = await res.json().catch(() => ({}));
			if (res.status === 429) {
				const retryAfter = typeof body?.retryAfter === "number" ? body.retryAfter : 60;
				startRetryCountdown(retryAfter);
				runNowError = true;
				return;
			}
			if (res.status === 503) {
				runNowMessage = "The briefing service is still starting up — try again in a moment.";
				runNowError = true;
				return;
			}
			runNowMessage = typeof body?.error === "string" ? body.error : "Failed to start the briefing.";
			runNowError = true;
		} catch {
			runNowMessage = "Failed to start the briefing.";
			runNowError = true;
		} finally {
			runNowBusy = false;
		}
	}

	onMount(() => {
		loadConfig();
		return () => stopRetryCountdown();
	});
</script>

<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
	<h2 class="mb-1 text-lg font-semibold text-[var(--color-text-primary)]">Daily Briefing</h2>
	<p class="mb-4 text-sm text-[var(--color-text-muted)]">
		Every morning, EZCorp mines your recent conversations, memories, and tasks and delivers
		the result as a new conversation you can talk back to.
	</p>

	{#if loading}
		<p class="text-sm text-[var(--color-text-secondary)]">Loading briefing settings...</p>
	{:else if loadError}
		<p class="text-sm text-red-400" data-testid="briefing-load-error">
			Unable to load briefing settings. Reload the page to try again.
		</p>
	{:else}
		<div class="flex flex-col gap-4">
			<!-- Enable toggle -->
			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					bind:checked={enabled}
					data-testid="briefing-enable-toggle"
					class="h-4 w-4 accent-[var(--color-accent)]"
				/>
				<span class="text-sm font-medium text-[var(--color-text-primary)]">Enable daily briefing</span>
			</label>

			<!-- Schedule -->
			{#if rawCron !== null}
				<div>
					<span class="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Schedule</span>
					<div class="flex items-center gap-3">
						<code
							class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-secondary)]"
							data-testid="briefing-raw-cron"
						>{rawCron}</code>
						<button
							onclick={switchToPicker}
							class="text-xs text-[var(--color-accent)] hover:underline"
							data-testid="briefing-use-picker"
						>
							Use the schedule picker instead
						</button>
					</div>
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">
						This schedule was set via the API as a raw cron expression and is shown as-is.
					</p>
				</div>
			{:else}
				<div class="flex flex-wrap items-end gap-3">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Time of day</span>
						<input
							type="time"
							bind:value={time}
							data-testid="briefing-time"
							class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Days</span>
						<select
							bind:value={preset}
							data-testid="briefing-preset"
							class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
						>
							{#each Object.entries(PRESET_LABELS) as [value, label]}
								<option {value}>{label}</option>
							{/each}
						</select>
					</label>
					{#if scheduleDescription}
						<span class="pb-1.5 text-xs text-[var(--color-text-muted)]" data-testid="briefing-schedule-desc">
							{scheduleDescription}
						</span>
					{/if}
				</div>
			{/if}

			<!-- Timezone -->
			<label class="flex max-w-xs flex-col gap-1">
				<span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Timezone</span>
				<input
					type="text"
					bind:value={timezone}
					list="briefing-timezones"
					data-testid="briefing-timezone"
					placeholder="e.g. Europe/Berlin"
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
				<datalist id="briefing-timezones">
					{#each timezoneOptions as tz}
						<option value={tz}></option>
					{/each}
				</datalist>
			</label>

			<!-- Target project -->
			<label class="flex max-w-xs flex-col gap-1">
				<span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Deliver to project</span>
				<select
					bind:value={projectId}
					data-testid="briefing-project"
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				>
					<option value="">Most recently active project</option>
					{#each projects as project (project.id)}
						<option value={project.id}>{project.name}</option>
					{/each}
				</select>
			</label>

			<!-- Instructions -->
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Instructions</span>
				<textarea
					bind:value={instructions}
					rows="4"
					data-testid="briefing-instructions"
					placeholder="e.g. Focus on work threads, keep it short, skip anything about household chores."
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
				></textarea>
				<span class="text-xs text-[var(--color-text-muted)]">
					Free text — this is appended to the briefing agent's prompt verbatim.
				</span>
			</label>

			<!-- Watchlist manager (Phase 3, spec §4.3 curation floor) -->
			<div class="flex flex-col gap-2">
				<span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Watchlist</span>
				<p class="text-xs text-[var(--color-text-muted)]">
					Topics your briefing researches overnight — add them here or just ask in any chat
					("keep an eye on … for me"). Topics are sent to your configured search provider.
				</p>
				{#if watchlist.length === 0}
					<p class="text-sm text-[var(--color-text-secondary)]" data-testid="briefing-watchlist-empty">
						No topics yet.
					</p>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each watchlist as entry (entry.topic)}
							<li
								class="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5"
								data-testid="briefing-watchlist-item"
							>
								<span class="text-sm text-[var(--color-text-primary)]">{entry.topic}</span>
								<button
									onclick={() => removeWatchlistTopic(entry.topic)}
									aria-label={`Remove ${entry.topic} from watchlist`}
									data-testid="briefing-watchlist-remove"
									class="text-xs text-[var(--color-text-muted)] transition-colors hover:text-red-400"
								>
									Remove
								</button>
							</li>
						{/each}
					</ul>
				{/if}
				<div class="flex max-w-md items-center gap-2">
					<input
						type="text"
						bind:value={newTopic}
						placeholder="e.g. Bun 2.0 release"
						data-testid="briefing-watchlist-input"
						onkeydown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								addWatchlistTopic();
							}
						}}
						class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
					<button
						onclick={addWatchlistTopic}
						data-testid="briefing-watchlist-add"
						class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
					>
						Add
					</button>
				</div>
				{#if watchlistError}
					<p class="text-xs text-amber-500" data-testid="briefing-watchlist-error">{watchlistError}</p>
				{/if}
			</div>

			<!-- Model override — the app-standard model picker -->
			<div class="flex max-w-md flex-col gap-1" data-testid="briefing-model">
				<span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Model override (optional)</span>
				<ModelSearchPicker
					selected={selectedModel}
					placeholder="Search models... (instance default)"
					onselect={(provider, model) => {
						selectedModel =
							provider === CURRENT_MODEL_SENTINEL ? null : { provider, model };
					}}
					onclear={() => {
						selectedModel = null;
					}}
				/>
			</div>

			<!-- Actions -->
			<div class="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
				<button
					onclick={save}
					disabled={saving}
					data-testid="briefing-save"
					class="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
				>
					{saving ? "Saving..." : "Save"}
				</button>
				<button
					onclick={runNow}
					disabled={runNowBusy || retrySeconds > 0}
					data-testid="briefing-run-now"
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
				>
					{runNowBusy ? "Starting..." : "Run now"}
				</button>
				{#if saveSuccess}
					<span class="text-sm text-green-500" data-testid="briefing-save-success">Saved.</span>
				{/if}
				{#if saveError}
					<span class="text-sm text-red-400" data-testid="briefing-save-error">{saveError}</span>
				{/if}
			</div>

			{#if retrySeconds > 0}
				<p class="text-sm text-amber-500" data-testid="briefing-retry-countdown">
					Briefing was already run recently — try again in {formatRetrySeconds(retrySeconds)}.
				</p>
			{:else if runNowMessage}
				<p
					class="text-sm {runNowError ? 'text-amber-500' : 'text-green-500'}"
					data-testid="briefing-run-now-message"
				>{runNowMessage}</p>
			{/if}

			<!-- Last-run status line -->
			<p class="text-xs text-[var(--color-text-muted)]" data-testid="briefing-last-run">
				{#if lastFireAt && lastFireStatus}
					Last run: {relativeTime(lastFireAt)} — {STATUS_LABELS[lastFireStatus] ?? lastFireStatus}
				{:else}
					No briefing has run yet.
				{/if}
			</p>
		</div>
	{/if}
</div>
