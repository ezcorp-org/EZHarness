export interface ProviderMeta {
	name: string;
	shortName: string;
	label: string;
	placeholder: string;
	oauthLabel: string;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
	anthropic: { name: "Anthropic (Claude)", shortName: "Anthropic", label: "A", placeholder: "sk-ant-...", oauthLabel: "" },
	openai: { name: "OpenAI", shortName: "OpenAI", label: "O", placeholder: "sk-...", oauthLabel: "Connect OpenAI Subscription" },
	google: { name: "Google (Gemini)", shortName: "Google", label: "G", placeholder: "AIza...", oauthLabel: "Connect Google Gemini" },
	ollama: { name: "Ollama (Local)", shortName: "Ollama", label: "L", placeholder: "", oauthLabel: "" },
};

const PROVIDER_ALIASES: Record<string, string> = {
	claude: "anthropic",
	gemini: "google",
};

export function canonicalProvider(provider: string): string {
	return PROVIDER_ALIASES[provider] ?? provider;
}

export function providerDisplayName(provider: string): string {
	const key = canonicalProvider(provider);
	return PROVIDER_META[key]?.name ?? provider;
}
