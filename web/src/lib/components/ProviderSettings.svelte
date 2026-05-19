<script lang="ts">
	import { fetchProviders, saveProviderKey, deleteProviderKey, disconnectOAuth, upsertSetting, fetchSettings, testProviderConnection, refreshProviderModels, type ProviderStatus } from "$lib/api.js";
	import { startOAuthFlow, completeOAuthWithCode, listenForOAuthResult, type OAuthPending } from "$lib/oauth.js";
	import { relativeTime } from "$lib/utils/relative-time.js";
	import AccessModeIcon from "./AccessModeIcon.svelte";
	import ProviderIcon from "./ProviderIcon.svelte";
	import { PROVIDER_META } from "$lib/provider-meta.js";

	let { statuses = $bindable([]) }: { statuses?: ProviderStatus[] } = $props();

	let providers = $state<ProviderStatus[]>([]);
	let saving = $state<Record<string, boolean>>({});
	let keyInputs = $state<Record<string, string>>({});
	let showKey = $state<Record<string, boolean>>({});
	let accessModes = $state<Record<string, string>>({});
	let errorMsg = $state<string | null>(null);

	// Per-provider UI action state: null | "editing" | "confirming-disconnect" | "confirming-remove"
	let cardAction = $state<Record<string, string | null>>({});
	// Per-provider test result or "testing" while in flight
	let testResults = $state<Record<string, { success: boolean; error?: string } | "testing">>({});
	// Per-provider model-refresh result or "refreshing" while in flight
	let refreshResults = $state<Record<string, { success: boolean; count?: number; error?: string } | "refreshing">>({});

	// OAuth code-paste flow state
	let oauthPending = $state<OAuthPending | null>(null);
	let codeInput = $state("");
	let oauthError = $state<string | null>(null);


	const ONBOARDING_LINKS: Record<string, { url: string; text: string }> = {
		anthropic: { url: "https://console.anthropic.com/keys", text: "Get your Anthropic API key" },
		openai: { url: "https://platform.openai.com/api-keys", text: "Get your OpenAI API key" },
		google: { url: "https://aistudio.google.com/apikey", text: "Get your Google API key" },
	};

	function autofocus(node: HTMLElement) { node.focus(); }

	async function load() {
		try {
			providers = await fetchProviders();
			// Load access mode preferences
			const settings = await fetchSettings();
			for (const p of providers) {
				const key = `provider:accessMode:${p.provider}`;
				if (settings[key]) accessModes = { ...accessModes, [p.provider]: settings[key] as string };
			}
			errorMsg = null;
		} catch {
			errorMsg = "Failed to load provider status";
		}
	}

	// Sync providers to bindable statuses prop
	$effect(() => { statuses = providers; });

	$effect(() => {
		load();
		const cleanup = listenForOAuthResult((result) => {
			if (result.success) load();
		});
		return cleanup;
	});

	async function handleSave(provider: string) {
		const key = keyInputs[provider]?.trim();
		if (!key) return;
		saving = { ...saving, [provider]: true };
		try {
			await saveProviderKey(provider, key);
			keyInputs = { ...keyInputs, [provider]: "" };
			showKey = { ...showKey, [provider]: false };
			cardAction = { ...cardAction, [provider]: null };
			await load();
		} catch {
			errorMsg = `Failed to save key for ${provider}`;
		} finally {
			saving = { ...saving, [provider]: false };
		}
	}

	async function handleRemove(provider: string) {
		saving = { ...saving, [provider]: true };
		try {
			await deleteProviderKey(provider);
			await load();
		} catch {
			errorMsg = `Failed to remove key for ${provider}`;
		} finally {
			saving = { ...saving, [provider]: false };
		}
	}

	async function handleConnect(provider: string) {
		saving = { ...saving, [provider]: true };
		oauthError = null;
		try {
			const pending = await startOAuthFlow(provider);
			oauthPending = pending;
			codeInput = "";
			// Open the auth URL in a new tab
			window.open(pending.authUrl, "_blank");
		} catch (err) {
			errorMsg = `Failed to start OAuth flow for ${provider}: ${err instanceof Error ? err.message : "unknown error"}`;
		} finally {
			saving = { ...saving, [provider]: false };
		}
	}

	async function handleSubmitCode() {
		if (!oauthPending || !codeInput.trim()) return;
		saving = { ...saving, [oauthPending.provider]: true };
		oauthError = null;
		try {
			const result = await completeOAuthWithCode(oauthPending, codeInput);
			if (result.success) {
				oauthPending = null;
				codeInput = "";
				await load();
			} else {
				oauthError = result.error ?? "Unknown error";
			}
		} catch (err) {
			oauthError = err instanceof Error ? err.message : "Unknown error";
		} finally {
			if (oauthPending) saving = { ...saving, [oauthPending.provider]: false };
		}
	}

	function handleCancelOAuth() {
		oauthPending = null;
		codeInput = "";
		oauthError = null;
	}

	async function handleDisconnect(provider: string) {
		saving = { ...saving, [provider]: true };
		try {
			await disconnectOAuth(provider);
			await load();
		} catch {
			errorMsg = `Failed to disconnect ${provider}`;
		} finally {
			saving = { ...saving, [provider]: false };
		}
	}

	async function handleAccessModeChange(provider: string, value: string) {
		accessModes = { ...accessModes, [provider]: value };
		try {
			await upsertSetting(`provider:accessMode:${provider}`, value);
		} catch {
			errorMsg = `Failed to save access mode for ${provider}`;
		}
	}

	function hasBothMethods(p: ProviderStatus): boolean {
		return p.oauthConnected && p.hasKey && p.source === "byok";
	}

	// New functions for enhanced UI
	async function handleTest(provider: string) {
		testResults = { ...testResults, [provider]: "testing" };
		try {
			const result = await testProviderConnection(provider);
			testResults = { ...testResults, [provider]: result };
		} catch {
			testResults = { ...testResults, [provider]: { success: false, error: "Connection failed" } };
		}
	}

	async function handleRefreshModels(provider: string) {
		refreshResults = { ...refreshResults, [provider]: "refreshing" };
		try {
			const result = await refreshProviderModels(provider);
			refreshResults = { ...refreshResults, [provider]: result };
		} catch {
			refreshResults = { ...refreshResults, [provider]: { success: false, error: "Request failed" } };
		}
	}

	function handleStartEdit(provider: string) {
		cardAction = { ...cardAction, [provider]: "editing" };
		keyInputs = { ...keyInputs, [provider]: "" };
	}

	function handleCancelAction(provider: string) {
		cardAction = { ...cardAction, [provider]: null };
	}

	async function handleConfirmDisconnect(provider: string) {
		await handleDisconnect(provider);
		cardAction = { ...cardAction, [provider]: null };
	}

	async function handleConfirmRemove(provider: string) {
		await handleRemove(provider);
		cardAction = { ...cardAction, [provider]: null };
	}

	function isOAuthActive(p: ProviderStatus): boolean {
		return p.oauthConnected && accessModes[p.provider] !== "apikey";
	}

	function isByokActive(p: ProviderStatus): boolean {
		if (!hasBothMethods(p)) return p.source === "byok";
		return accessModes[p.provider] === "apikey";
	}
</script>

{#if errorMsg}
	<div class="mb-4 rounded-md border border-red-800 bg-red-900/30 p-3 text-sm text-red-300">
		{errorMsg}
	</div>
{/if}

<!-- OAuth code-paste dialog -->
{#if oauthPending}
	{@const info = PROVIDER_META[oauthPending.provider]}
	<div class="mb-4 rounded-lg border border-blue-800 bg-blue-900/20 p-4">
		<h3 class="mb-2 text-sm font-medium text-[var(--color-text-primary)]">Connect {info?.name ?? oauthPending.provider}</h3>
		<p class="mb-3 text-xs text-[var(--color-text-secondary)]">
			A login page should have opened in a new tab. After authenticating, the connection should complete automatically.
			If it doesn't, copy the <strong>entire URL</strong> from your browser's address bar and paste it below.
		</p>
		<div class="mb-2 flex items-center gap-2">
			<input
				type="text"
				bind:value={codeInput}
				placeholder="Paste the callback URL here if automatic redirect didn't work"
				class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				onkeydown={(e) => { if (e.key === "Enter") handleSubmitCode(); }}
			/>
			<button
				onclick={handleSubmitCode}
				disabled={!codeInput.trim() || saving[oauthPending.provider]}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
			>
				{saving[oauthPending.provider] ? "Connecting..." : "Submit"}
			</button>
			<button
				onclick={handleCancelOAuth}
				class="rounded-md px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
			>
				Cancel
			</button>
		</div>
		{#if oauthError}
			<p class="text-xs text-red-400">{oauthError}</p>
		{/if}
		<details class="mt-2">
			<summary class="cursor-pointer text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">Auth URL (click to copy)</summary>
			<div class="mt-1 flex items-center gap-2">
				<code class="block flex-1 truncate rounded bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-secondary)]">{oauthPending.authUrl}</code>
				<button
					onclick={() => navigator.clipboard.writeText(oauthPending!.authUrl)}
					class="shrink-0 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
				>
					Copy
				</button>
			</div>
		</details>
	</div>
{/if}

<div class="space-y-3">
	{#each providers as p}
		{@const info = PROVIDER_META[p.provider] ?? { name: p.provider, shortName: p.provider, label: "?", placeholder: "API key...", oauthLabel: "" }}
		{@const onboardingLink = ONBOARDING_LINKS[p.provider]}
		{@const action = cardAction[p.provider] ?? null}
		{@const testResult = testResults[p.provider]}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
			<div class="flex items-center gap-4">
				<ProviderIcon provider={p.provider} size="lg" />
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium text-[var(--color-text-primary)]">{info.name}</span>
						<!-- Status dot + text -->
						{#if !p.hasKey && !p.oauthConnected}
							<span class="inline-flex items-center gap-1 text-xs">
								<span class="h-2 w-2 rounded-full bg-gray-500"></span>
								<span class="text-[var(--color-text-muted)]">Not configured</span>
							</span>
						{:else if p.oauthExpired}
							<span class="inline-flex items-center gap-1 text-xs">
								<span class="h-2 w-2 rounded-full bg-amber-500"></span>
								<span class="text-amber-400">Token expired</span>
							</span>
						{:else}
							<span class="inline-flex items-center gap-1 text-xs">
								<span class="h-2 w-2 rounded-full bg-green-500"></span>
								<span class="text-green-400">Connected</span>
							</span>
						{/if}
					</div>

					<!-- Access mode badges -->
					<div class="mt-1 flex items-center gap-2">
						{#if p.oauthConnected}
							<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs {isOAuthActive(p) ? 'bg-green-900/40 text-green-400' : 'bg-green-900/20 text-green-600'}">
								<AccessModeIcon type="oauth" provider={p.provider} />
								Subscription
							</span>
						{/if}
						{#if p.source === "byok"}
							<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs {isByokActive(p) ? 'bg-blue-900/40 text-blue-400' : 'bg-blue-900/20 text-blue-600'}">
								<AccessModeIcon type="apikey" />
								API Key
							</span>
						{/if}
						{#if p.source === "env"}
							<span class="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-tertiary)]/40 px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
								Env
							</span>
						{/if}
					</div>

					<!-- Token expiry display -->
					{#if p.expiresAt}
						<span class="mt-1 inline-block text-xs {p.oauthExpired ? 'text-amber-400' : 'text-[var(--color-text-muted)]'}">
							{relativeTime(p.expiresAt)}
						</span>
					{/if}

					<!-- Test button + result -->
					{#if p.hasKey || p.oauthConnected}
						{@const refreshResult = refreshResults[p.provider]}
						<div class="mt-1.5 flex flex-wrap items-center gap-2">
							<button
								onclick={() => handleTest(p.provider)}
								disabled={testResult === "testing"}
								class="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 transition-colors"
							>
								{testResult === "testing" ? "Testing..." : "Test"}
							</button>
							{#if testResult && testResult !== "testing"}
								{#if testResult.success}
									<span class="inline-flex items-center gap-1 text-xs text-green-400">
										<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
										</svg>
										Working
									</span>
								{:else}
									<span class="inline-flex items-center gap-1 text-xs text-red-400">
										<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
										</svg>
										{testResult.error ?? "Failed"}
									</span>
								{/if}
							{/if}
							<button
								onclick={() => handleRefreshModels(p.provider)}
								disabled={refreshResult === "refreshing"}
								title="Fetch the latest model list from {info.name}"
								class="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 transition-colors"
							>
								{refreshResult === "refreshing" ? "Fetching..." : "Refresh models"}
							</button>
							{#if refreshResult && refreshResult !== "refreshing"}
								{#if refreshResult.success}
									<span class="text-xs text-green-400">Loaded {refreshResult.count} models</span>
								{:else}
									<span class="text-xs text-red-400" title={refreshResult.error}>Refresh failed</span>
								{/if}
							{/if}
						</div>
					{/if}

					<!-- API Key section -->
					{#if p.source === "byok" && action !== "editing"}
						<div class="mt-2 flex items-center gap-2">
							{#if action === "confirming-remove"}
								<span class="text-xs text-red-300">Remove API key?</span>
								<button
									onclick={() => handleConfirmRemove(p.provider)}
									disabled={saving[p.provider]}
									class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
								>
									{saving[p.provider] ? "Removing..." : "Confirm"}
								</button>
								<button
									onclick={() => handleCancelAction(p.provider)}
									class="rounded-md px-2 py-0.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
								>
									Cancel
								</button>
							{:else}
								<span class="text-xs text-[var(--color-text-secondary)]">Key saved</span>
								<button
									onclick={() => handleStartEdit(p.provider)}
									class="rounded-md px-2 py-1 text-xs text-blue-400 hover:bg-[var(--color-surface-secondary)] hover:text-blue-300 transition-colors"
								>
									Update
								</button>
								<button
									onclick={() => { cardAction = { ...cardAction, [p.provider]: "confirming-remove" }; }}
									disabled={saving[p.provider]}
									class="rounded-md px-2 py-1 text-xs text-red-400 hover:bg-[var(--color-surface-secondary)] hover:text-red-300 disabled:opacity-50 transition-colors"
								>
									Remove
								</button>
							{/if}
						</div>
					{:else if p.source === "byok" && action === "editing"}
						<div class="mt-2 flex items-center gap-2">
							<div class="relative flex-1">
								<input
									use:autofocus
									type={showKey[p.provider] ? "text" : "password"}
									bind:value={keyInputs[p.provider]}
									placeholder={info.placeholder}
									class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
								/>
								<button
									onclick={() => (showKey = { ...showKey, [p.provider]: !showKey[p.provider] })}
									class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
									title={showKey[p.provider] ? "Hide" : "Show"}
									type="button"
								>
									<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										{#if showKey[p.provider]}
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
										{:else}
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
										{/if}
									</svg>
								</button>
							</div>
							<button
								onclick={() => handleSave(p.provider)}
								disabled={saving[p.provider] || !keyInputs[p.provider]?.trim()}
								class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
							>
								{saving[p.provider] ? "Saving..." : "Save"}
							</button>
							<button
								onclick={() => handleCancelAction(p.provider)}
								class="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
							>
								Cancel
							</button>
						</div>
					{:else if p.source === "none" && !p.oauthConnected}
						<!-- Onboarding hint -->
						{#if onboardingLink}
							<p class="mt-1.5 text-xs text-[var(--color-text-muted)]">
								{#if p.oauthSupported}
									Connect your {info.name} subscription or paste an API key.
								{:else}
									Paste an API key to get started.
								{/if}
								<a
									href={onboardingLink.url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-blue-400 hover:text-blue-300 transition-colors"
								>
									{onboardingLink.text}
								</a>
							</p>
						{/if}
						<div class="mt-2 flex items-center gap-2">
							<div class="relative flex-1">
								<input
									type={showKey[p.provider] ? "text" : "password"}
									bind:value={keyInputs[p.provider]}
									placeholder={info.placeholder}
									class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
								/>
								<button
									onclick={() => (showKey = { ...showKey, [p.provider]: !showKey[p.provider] })}
									class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
									title={showKey[p.provider] ? "Hide" : "Show"}
									type="button"
								>
									<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										{#if showKey[p.provider]}
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
										{:else}
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
										{/if}
									</svg>
								</button>
							</div>
							<button
								onclick={() => handleSave(p.provider)}
								disabled={saving[p.provider] || !keyInputs[p.provider]?.trim()}
								class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
							>
								{saving[p.provider] ? "Saving..." : "Save Key"}
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!-- OAuth section (divider + OAuth controls) -->
			{#if p.oauthSupported}
				<div class="mt-3 border-t border-[var(--color-border)] pt-3">
					{#if p.oauthConnected}
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								{#if p.oauthExpired}
									<span class="inline-flex items-center gap-1 rounded-full bg-amber-900/40 px-2 py-0.5 text-xs text-amber-400">
										<span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
										Expired
									</span>
									<button
										onclick={() => handleConnect(p.provider)}
										disabled={saving[p.provider]}
										class="text-xs text-amber-400 hover:text-amber-300 transition-colors"
									>
										Reconnect
									</button>
								{:else}
									<span class="inline-flex items-center gap-1 rounded-full bg-green-900/40 px-2 py-0.5 text-xs text-green-400">
										<span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>
										Subscription Connected
									</span>
								{/if}
							</div>
							{#if action === "confirming-disconnect"}
								<div class="flex items-center gap-2">
									<span class="text-xs text-red-300">Disconnect {info.name} subscription?</span>
									<button
										onclick={() => handleConfirmDisconnect(p.provider)}
										disabled={saving[p.provider]}
										class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
									>
										{saving[p.provider] ? "Disconnecting..." : "Confirm"}
									</button>
									<button
										onclick={() => handleCancelAction(p.provider)}
										class="rounded-md px-2 py-0.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
									>
										Cancel
									</button>
								</div>
							{:else}
								<button
									onclick={() => { cardAction = { ...cardAction, [p.provider]: "confirming-disconnect" }; }}
									disabled={saving[p.provider]}
									class="rounded-md px-2 py-1 text-xs text-red-400 hover:bg-[var(--color-surface-secondary)] hover:text-red-300 disabled:opacity-50 transition-colors"
								>
									Disconnect
								</button>
							{/if}
						</div>
					{:else}
						<button
							onclick={() => handleConnect(p.provider)}
							disabled={saving[p.provider]}
							class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50 transition-colors"
						>
							{saving[p.provider] ? "Connecting..." : info.oauthLabel || `Connect ${info.name}`}
						</button>
					{/if}
				</div>
			{:else if p.provider === "anthropic" && p.source === "none" && !p.hasKey}
				<div class="mt-3 border-t border-[var(--color-border)] pt-3">
					<p class="text-xs text-[var(--color-text-muted)]">
						OAuth not available -- Anthropic requires API keys.
					</p>
				</div>
			{/if}

			<!-- Access mode preference (shown when both OAuth and BYOK are available) -->
			{#if hasBothMethods(p)}
				<div class="mt-3 border-t border-[var(--color-border)] pt-3">
					<label class="flex items-center gap-2">
						<span class="text-xs text-[var(--color-text-secondary)]">Preferred access:</span>
						<select
							value={accessModes[p.provider] ?? "auto"}
							onchange={(e) => handleAccessModeChange(p.provider, (e.target as HTMLSelectElement).value)}
							class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
						>
							<option value="auto">Auto (try subscription first)</option>
							<option value="oauth">Prefer Subscription</option>
							<option value="apikey">Prefer API Key</option>
						</select>
					</label>
				</div>
			{/if}
		</div>
	{/each}
</div>
