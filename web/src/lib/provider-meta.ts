export interface ProviderMeta {
	name: string;
	shortName: string;
	label: string;
	placeholder: string;
	oauthLabel: string;
	/**
	 * This provider answers with no credential configured, for some subset of
	 * its models. Mirrors `keylessFreeTier` in the backend's provider table
	 * (`src/runtime/routing/llm-providers.ts`); pinned to it by
	 * `provider-meta.unit.test.ts`, which parses that file rather than
	 * importing it (the cross-tree coverage trap in the root CLAUDE.md).
	 *
	 * Drives the provider card: "Not configured" is wrong and discouraging for
	 * a provider that is, in fact, already usable.
	 */
	keylessFreeTier?: boolean;
	/** Shown on the card when the free tier is what is currently in use. */
	freeTierNote?: string;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
	anthropic: { name: "Anthropic (Claude)", shortName: "Anthropic", label: "A", placeholder: "sk-ant-...", oauthLabel: "" },
	openai: { name: "OpenAI", shortName: "OpenAI", label: "O", placeholder: "sk-...", oauthLabel: "Connect OpenAI Subscription" },
	google: { name: "Google (Gemini)", shortName: "Google", label: "G", placeholder: "AIza...", oauthLabel: "Connect Google Gemini" },
	openrouter: { name: "OpenRouter", shortName: "OpenRouter", label: "OR", placeholder: "sk-or-v1-...", oauthLabel: "" },
	// Kilo needs no key for its free models — the placeholder says so, because
	// this card is the one place a user decides whether to bother getting one.
	kilo: {
		name: "Kilo (Gateway)",
		shortName: "Kilo",
		label: "K",
		placeholder: "Optional — free models need no key",
		oauthLabel: "",
		keylessFreeTier: true,
		// The training caveat is Kilo's own, and it is the single fact a user
		// most needs before sending a prompt to a $0 endpoint. Burying it in a
		// doc would be the wrong call: the decision is made on this card.
		freeTierNote:
			"Free models work with no API key. Kilo may log free-tier prompts and responses to improve its providers' services — add a key to use paid models, which are not shared.",
	},
	ollama: { name: "Ollama (Local)", shortName: "Ollama", label: "L", placeholder: "", oauthLabel: "" },
};

const PROVIDER_ALIASES: Record<string, string> = {
	claude: "anthropic",
	gemini: "google",
};

export function canonicalProvider(provider: string): string {
	return PROVIDER_ALIASES[provider] ?? provider;
}
