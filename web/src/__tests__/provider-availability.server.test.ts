/**
 * `resolveProviderAvailability` — the ONE definition of "can this deployment
 * call that provider?", shared by `/api/models` (picker availability) and
 * `/api/models/capabilities?provider=auto` (which rungs may narrow the
 * attachment intersection).
 *
 * It matters that the two agree: if the capabilities route counted a provider
 * the picker calls unavailable, an unreachable rung would silently strip
 * capabilities from every Auto conversation. That is the bug this module was
 * extracted to prevent, so the precedence and the failure modes are pinned.
 */

import { test, expect, describe, beforeEach, vi } from "vitest";

const settings = new Map<string, unknown>();
const credentials = new Map<string, { type: string }>();

vi.mock("$server/db/queries/settings", () => ({
	getSetting: vi.fn(async (key: string) => settings.get(key)),
}));

vi.mock("$server/providers/credentials", () => ({
	getCredential: vi.fn(async (provider: string) => {
		const cred = credentials.get(provider);
		if (!cred) throw new Error(`no credential for ${provider}`);
		return cred;
	}),
}));

const { resolveProviderAvailability, ENV_KEYS } = await import("$lib/server/provider-availability");

describe("resolveProviderAvailability", () => {
	beforeEach(() => {
		settings.clear();
		credentials.clear();
		for (const key of Object.values(ENV_KEYS)) delete process.env[key];
	});

	test("a provider with no env key, no BYOK and no OAuth is unavailable", async () => {
		const { available, credentialTypes } = await resolveProviderAvailability(["anthropic"]);
		expect(available.has("anthropic")).toBe(false);
		expect(credentialTypes.size).toBe(0);
	});

	test("an env var alone makes a provider available", async () => {
		process.env[ENV_KEYS.anthropic!] = "sk-test";
		credentials.set("anthropic", { type: "api-key" });
		const { available, credentialTypes } = await resolveProviderAvailability(["anthropic"]);
		expect(available.has("anthropic")).toBe(true);
		expect(credentialTypes.get("anthropic")).toBe("api-key");
	});

	test("a BYOK setting alone makes a provider available", async () => {
		settings.set("provider:apiKey:openai", "sk-byok");
		credentials.set("openai", { type: "api-key" });
		const { available } = await resolveProviderAvailability(["openai"]);
		expect(available.has("openai")).toBe(true);
	});

	test("an OAuth setting alone makes a provider available, and reports its type", async () => {
		settings.set("provider:oauth:google", { token: "x" });
		credentials.set("google", { type: "oauth" });
		const { available, credentialTypes } = await resolveProviderAvailability(["google"]);
		expect(available.has("google")).toBe(true);
		// /api/models narrows OAuth providers to their supported variants off this.
		expect(credentialTypes.get("google")).toBe("oauth");
	});

	test("CONFIGURED but unusable is unavailable — a throwing getCredential demotes", async () => {
		// Expired refresh token / unreadable secret: the key exists in settings
		// but cannot produce a credential. Serving a model that cannot answer is
		// worse than hiding it.
		settings.set("provider:apiKey:openai", "sk-rotted");
		const { available, credentialTypes } = await resolveProviderAvailability(["openai"]);
		expect(available.has("openai")).toBe(false);
		expect(credentialTypes.has("openai")).toBe(false);
	});

	test("probes each DISTINCT provider once, however often it is named", async () => {
		const creds = await import("$server/providers/credentials");
		settings.set("provider:apiKey:openai", "sk");
		credentials.set("openai", { type: "api-key" });
		vi.mocked(creds.getCredential).mockClear();

		await resolveProviderAvailability(["openai", "openai", "openai"]);
		expect(vi.mocked(creds.getCredential)).toHaveBeenCalledTimes(1);
	});

	test("resolves a mixed set independently", async () => {
		settings.set("provider:apiKey:openai", "sk");
		credentials.set("openai", { type: "api-key" });
		settings.set("provider:apiKey:ollama", "x"); // configured, but credential throws
		const { available } = await resolveProviderAvailability(["openai", "ollama", "anthropic"]);
		expect([...available].sort()).toEqual(["openai"]);
	});

	test("no providers named yields an empty result rather than throwing", async () => {
		const { available, credentialTypes } = await resolveProviderAvailability([]);
		expect(available.size).toBe(0);
		expect(credentialTypes.size).toBe(0);
	});

	test("an empty-string env var does NOT count as configured", async () => {
		process.env[ENV_KEYS.anthropic!] = "";
		const { available } = await resolveProviderAvailability(["anthropic"]);
		expect(available.has("anthropic")).toBe(false);
	});
});
