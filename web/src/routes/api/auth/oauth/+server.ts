import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { upsertSetting } from "$server/db/queries/settings";
import { OAUTH_CONFIG } from "$lib/server/oauth-config";
import { startOAuthCallbackServer } from "$server/auth/oauth-callback-server";
import { errorJson } from "$lib/server/http-errors";
import { logger } from "$server/logger";

const log = logger.child("api.auth.oauth");

/** Base64url encode without padding. */
function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE verifier + S256 challenge pair server-side. */
async function generatePkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const codeVerifier = base64UrlEncode(bytes);

	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
	const codeChallenge = base64UrlEncode(new Uint8Array(hash));

	return { codeVerifier, codeChallenge };
}

function buildAuthUrl(
	provider: string,
	redirectUri: string,
	state: string,
	codeChallenge: string,
): string {
	const config = OAUTH_CONFIG[provider];
	if (!config) throw new Error(`No OAuth config for ${provider}`);

	const params = new URLSearchParams({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: redirectUri,
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		scope: config.scopes,
	});

	if (provider === "openai") {
		params.set("id_token_add_organizations", "true");
		params.set("codex_cli_simplified_flow", "true");
		params.set("originator", "pi");
	}

	if (provider === "google") {
		params.set("access_type", "offline");
	}

	return `${config.authEndpoint}?${params.toString()}`;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	requireAuth(locals);

	const provider = url.searchParams.get("provider");
	if (!provider || !["openai", "google", "anthropic"].includes(provider)) {
		return errorJson(400, "Invalid provider. Must be one of: openai, google, anthropic");
	}

	if (provider === "anthropic") {
		return errorJson(400, "OAuth not available for Anthropic. Use API keys.");
	}

	const config = OAUTH_CONFIG[provider];
	if (!config) {
		return errorJson(400, `No OAuth config for ${provider}`);
	}

	try {
		const state = crypto.randomUUID();
		const { codeVerifier, codeChallenge } = await generatePkcePair();

		// sec-M1: validate app_origin to prevent open-redirect. Pre-fix the
		// value was concatenated into appCallbackUrl and passed to the
		// callback subprocess, which issued a 302 to the attacker-chosen
		// host. Accept only the request's own origin; anything else falls
		// back silently to url.origin so a stale caller doesn't break the
		// legitimate flow.
		const rawAppOrigin = url.searchParams.get("app_origin");
		let appOrigin = url.origin;
		if (rawAppOrigin) {
			let parsedOrigin: string | null = null;
			try {
				parsedOrigin = new URL(rawAppOrigin).origin;
			} catch {
				parsedOrigin = null;
			}
			if (parsedOrigin && parsedOrigin === url.origin) {
				appOrigin = parsedOrigin;
			} else {
				log.warn("rejected untrusted app_origin; falling back to request origin", {
					rawAppOrigin,
					fallbackOrigin: url.origin,
				});
			}
		}
		const appCallbackUrl = `${appOrigin}/auth/callback`;
		const redirectUri = config.redirectUri;

		try {
			startOAuthCallbackServer(config.callbackPort, appCallbackUrl);
			log.info("callback server started", { port: config.callbackPort, appCallbackUrl });
		} catch (err) {
			log.error("failed to start callback server", {
				port: config.callbackPort,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// sec-M2: store {state, codeVerifier, redirectUri, provider, createdAt}
		// server-side, keyed by state. The codeVerifier NEVER leaves the
		// server — pre-fix it was returned in this JSON body and lived in
		// frontend state, where any shared-origin XSS would disclose it.
		// The callback looks up this record by state, uses the stored
		// codeVerifier for PKCE, and deletes the record (one-shot).
		await upsertSetting(`oauth:pending:${state}`, {
			state,
			codeVerifier,
			redirectUri,
			provider,
			createdAt: Date.now(),
		});

		const authUrl = buildAuthUrl(provider, redirectUri, state, codeChallenge);
		// sec-M2: do NOT return codeVerifier — it stays server-side.
		// state and redirectUri remain so the frontend CSRF comparison and
		// callback POST body still work; they are not secrets.
		return json({ url: authUrl, state, redirectUri });
	} catch (e) {
		log.error("oauth flow failed", {
			provider,
			error: e instanceof Error ? e.message : String(e),
		});
		return errorJson(400, (e as Error).message);
	}
};
