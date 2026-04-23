import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { encrypt } from "$server/providers/encryption";
import { getSetting, upsertSetting, deleteSetting } from "$server/db/queries/settings";
import { requireAuth } from "$server/auth/middleware";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { OAUTH_CONFIG } from "$lib/server/oauth-config";

const VALID_PROVIDERS = ["openai", "google"] as const;

function isValidProvider(p: string): p is (typeof VALID_PROVIDERS)[number] {
	return VALID_PROVIDERS.includes(p as any);
}

/**
 * Exchange an authorization code for tokens using PKCE verifier.
 * Returns pi-ai OAuthCredentials format: { access, refresh, expires }.
 */
async function exchangeCode(
	provider: string,
	code: string,
	codeVerifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	const config = OAUTH_CONFIG[provider];
	if (!config) throw new Error(`No OAuth config for ${provider}`);

	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		code_verifier: codeVerifier,
		redirect_uri: redirectUri,
		client_id: config.clientId,
		...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
	});

	const res = await fetch(config.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!res.ok) {
		throw new Error(`Token exchange failed for ${provider}: ${res.status}`);
	}

	const data = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};

	// Store in pi-ai OAuthCredentials format
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? "",
		expires: Date.now() + data.expires_in * 1000,
	};
}

// sec-M2: pending OAuth record stored server-side by the initiator. The
// codeVerifier never leaves the server; the record is keyed by state and
// consumed one-shot on successful exchange.
interface PendingOAuth {
	state: string;
	codeVerifier: string;
	redirectUri: string;
	provider: string;
	createdAt: number;
}

// 10 minute TTL — long enough for a user to authorize with the provider
// and paste the callback URL, short enough to bound replay risk if the
// pending record leaks or is missed by cleanup.
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export const POST: RequestHandler = async ({ request, locals }) => {
	requireAuth(locals);

	const body = await request.json();
	const { provider, code, state } = body as {
		provider: string;
		code: string;
		state?: string;
	};

	if (!provider || !isValidProvider(provider)) {
		return errorJson(400, "Invalid provider. Must be one of: openai, google");
	}

	if (!code) {
		return errorJson(400, "code is required");
	}

	if (!state) {
		return errorJson(400, "state is required");
	}

	// sec-M2: look up the server-side pending record for this state. Pre-fix
	// the callback accepted codeVerifier + state directly from the frontend
	// request body and never compared state to anything stored — relying
	// purely on PKCE. If the verifier ever leaked (it was returned to the
	// client in the initiator response), an attacker could forge the whole
	// exchange. Now state is the lookup key, so a missing record means the
	// state is unknown/replayed/expired.
	const pending = (await getSetting(`oauth:pending:${state}`)) as PendingOAuth | undefined;
	if (!pending || typeof pending !== "object") {
		return errorJson(400, "Invalid or expired state");
	}

	// Defence-in-depth: stored provider must match the request.
	if (pending.provider !== provider) {
		await deleteSetting(`oauth:pending:${state}`);
		return errorJson(400, "Invalid or expired state");
	}

	// TTL enforcement — expired records are cleaned up lazily here.
	if (Date.now() - pending.createdAt > OAUTH_PENDING_TTL_MS) {
		await deleteSetting(`oauth:pending:${state}`);
		return errorJson(400, "Invalid or expired state");
	}

	try {
		const tokenData = await exchangeCode(
			provider,
			code,
			pending.codeVerifier,
			pending.redirectUri,
		);
		const encrypted = encrypt(JSON.stringify(tokenData));
		await upsertSetting(`provider:oauth:${provider}`, encrypted);

		// sec-M2: one-shot — consume the pending record only after a
		// successful token exchange + persist. If exchange fails the
		// record stays so the user can retry without losing state,
		// but it will still expire after the TTL.
		await deleteSetting(`oauth:pending:${state}`);

		return json({ success: true, provider });
	} catch (e) {
		return errorJson(400, (e as Error).message);
	}
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	requireAuth(locals);

	const body = await request.json();
	const { provider } = body as { provider: string };

	if (!provider || !isValidProvider(provider)) {
		return errorJson(400, "Invalid provider. Must be one of: openai, google");
	}

	await deleteSetting(`provider:oauth:${provider}`);
	return json({ success: true });
};
