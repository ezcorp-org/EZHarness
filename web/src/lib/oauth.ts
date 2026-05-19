import { initiateOAuth, completeOAuth } from "$lib/api.js";

const KNOWN_PROVIDERS = ["openai", "google", "anthropic"] as const;
const CHANNEL_NAME = "ezcorp-oauth";

export type OAuthProvider = (typeof KNOWN_PROVIDERS)[number];

export interface OAuthResult {
	provider: string;
	success: boolean;
	error?: string;
}

export interface OAuthPending {
	authUrl: string;
	codeVerifier: string;
	state: string;
	provider: string;
	redirectUri: string;
}

/**
 * Start an OAuth flow: generates the auth URL and PKCE pair.
 * Returns the pending state so the UI can show the URL and code input.
 */
export async function startOAuthFlow(provider: string): Promise<OAuthPending> {
	const { url, state, codeVerifier, redirectUri } = await initiateOAuth(provider);
	const pending = { authUrl: url, codeVerifier, state, provider, redirectUri };

	// Persist for the callback page (opens in a new tab, so localStorage not sessionStorage)
	try {
		localStorage.setItem("ezcorp-oauth-pending", JSON.stringify(pending));
	} catch {
		// localStorage unavailable -- fallback to manual paste
	}

	return pending;
}

/**
 * Parse a pasted OAuth callback input.
 * Accepts a full URL (http://localhost:1455/auth/callback?code=xxx&state=yyy)
 * or just the code string.
 */
function parseCallbackInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	// Try query string format: code=xxx&state=yyy
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	// Bare code
	return { code: value };
}

/**
 * Complete the OAuth flow with a pasted callback URL or code.
 */
export async function completeOAuthWithCode(
	pending: OAuthPending,
	pastedInput: string,
): Promise<OAuthResult> {
	const { code, state } = parseCallbackInput(pastedInput);

	if (!code) {
		return { provider: pending.provider, success: false, error: "Could not find authorization code in input" };
	}

	// Validate state if it was present in the pasted input
	if (state && state !== pending.state) {
		return { provider: pending.provider, success: false, error: "State mismatch -- possible CSRF attack" };
	}

	try {
		await completeOAuth(pending.provider, code, pending.codeVerifier, pending.redirectUri, pending.state);
		const result: OAuthResult = { provider: pending.provider, success: true };
		postOAuthResult(result);
		return result;
	} catch (err) {
		const error = err instanceof Error ? err.message : "Token exchange failed";
		return { provider: pending.provider, success: false, error };
	}
}

/** Post an OAuth result via BroadcastChannel for cross-tab communication. */
function postOAuthResult(result: OAuthResult): void {
	try {
		const channel = new BroadcastChannel(CHANNEL_NAME);
		channel.postMessage({
			type: result.success ? "oauth-success" : "oauth-error",
			provider: result.provider,
			error: result.error,
		});
		channel.close();
	} catch {
		// BroadcastChannel not supported -- fallback handled by manual refresh
	}
}

/**
 * Listen for OAuth results via BroadcastChannel.
 * Returns a cleanup function to stop listening.
 */
export function listenForOAuthResult(callback: (result: OAuthResult) => void): () => void {
	try {
		const channel = new BroadcastChannel(CHANNEL_NAME);
		const handler = (event: MessageEvent) => {
			const data = event.data;
			if (data?.type === "oauth-success") {
				callback({ provider: data.provider, success: true });
			} else if (data?.type === "oauth-error") {
				callback({ provider: data.provider, success: false, error: data.error });
			}
		};
		channel.addEventListener("message", handler);
		return () => {
			channel.removeEventListener("message", handler);
			channel.close();
		};
	} catch {
		// BroadcastChannel not supported
		return () => {};
	}
}

/**
 * Parse `/login <provider>` commands from chat input.
 * Returns { provider } if valid, null otherwise.
 */
export function isLoginCommand(content: string): { provider: string } | null {
	const trimmed = content.trim();
	const match = trimmed.match(/^\/login\s+(\S+)$/i);
	if (!match) {
		// Check for bare /login with no args
		if (/^\/login\s*$/i.test(trimmed)) return { provider: "" };
		return null;
	}
	const provider = match[1]!.toLowerCase();
	if (KNOWN_PROVIDERS.includes(provider as OAuthProvider)) {
		return { provider };
	}
	return { provider }; // Return even unknown providers so caller can show usage help
}
