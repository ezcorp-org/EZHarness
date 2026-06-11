<script lang="ts">
	import { completeOAuth } from "$lib/api.js";

	let status = $state<"loading" | "success" | "error">("loading");
	let errorMessage = $state("");
	let providerName = $state("Provider");

	const PROVIDER_NAMES: Record<string, string> = {
		openai: "OpenAI",
		google: "Google Gemini",
		anthropic: "Anthropic",
	};

	const STORAGE_KEY = "ezcorp-oauth-pending";
	const CHANNEL_NAME = "ezcorp-oauth";

	$effect(() => {
		const params = new URLSearchParams(window.location.search);
		const code = params.get("code");
		const state = params.get("state");

		if (!code || !state) {
			status = "error";
			errorMessage = "Missing code or state parameter";
			return;
		}

		// Read pending OAuth state from localStorage (written by startOAuthFlow in the opener tab)
		const raw = localStorage.getItem(STORAGE_KEY);
		localStorage.removeItem(STORAGE_KEY);

		if (!raw) {
			status = "error";
			errorMessage = "No pending OAuth session found. Please paste the URL into the app instead.";
			return;
		}

		const pending = JSON.parse(raw) as { codeVerifier: string; state: string; provider: string; redirectUri: string };

		if (pending.state !== state) {
			status = "error";
			errorMessage = "State mismatch -- possible CSRF attack";
			return;
		}

		providerName = PROVIDER_NAMES[pending.provider] ?? pending.provider;

		completeOAuth(pending.provider, code, pending.codeVerifier, pending.redirectUri, state)
			.then(() => {
				status = "success";
				// Notify the opener tab
				try {
					const channel = new BroadcastChannel(CHANNEL_NAME);
					channel.postMessage({ type: "oauth-success", provider: pending.provider });
					channel.close();
				} catch {}
				setTimeout(() => window.close(), 1500);
			})
			.catch((err: unknown) => {
				status = "error";
				errorMessage = err instanceof Error ? err.message : "Token exchange failed";
			});
	});
</script>

<div class="flex min-h-screen items-center justify-center bg-[var(--color-surface)]">
	<div class="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center">
		{#if status === "loading"}
			<div class="mb-4 flex justify-center">
				<svg class="h-10 w-10 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
			</div>
			<p class="text-sm text-[var(--color-text-secondary)]">Completing authentication...</p>

		{:else if status === "success"}
			<div class="mb-4 flex justify-center">
				<svg class="h-10 w-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
				</svg>
			</div>
			<h2 class="mb-2 text-lg font-semibold text-[var(--color-text-primary)]">{providerName} Connected</h2>
			<p class="text-sm text-[var(--color-text-secondary)]">This tab will close automatically...</p>

		{:else}
			<div class="mb-4 flex justify-center">
				<svg class="h-10 w-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</div>
			<h2 class="mb-2 text-lg font-semibold text-[var(--color-text-primary)]">Connection Failed</h2>
			<p class="mb-4 text-sm text-red-400">{errorMessage}</p>
			<a
				href="/settings/models"
				class="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
			>
				Try Again
			</a>
		{/if}
	</div>
</div>
