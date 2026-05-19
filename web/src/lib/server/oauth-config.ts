/**
 * Shared OAuth provider config for the web frontend's redirect flow.
 * Imported by both the /api/auth/oauth GET handler and the callback POST handler.
 */
export const OAUTH_CONFIG: Record<string, {
	authEndpoint: string;
	tokenEndpoint: string;
	clientId: string;
	clientSecret?: string;
	scopes: string;
	apiEndpoint?: string;
	redirectUri: string;
	callbackPort: number;
}> = {
	openai: {
		authEndpoint: "https://auth.openai.com/oauth/authorize",
		tokenEndpoint: "https://auth.openai.com/oauth/token",
		clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
		scopes: "openid profile email offline_access",
		apiEndpoint: "https://chatgpt.com/backend-api/codex/responses",
		redirectUri: "http://localhost:1455/auth/callback",
		callbackPort: 1455,
	},
	google: {
		authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenEndpoint: "https://oauth2.googleapis.com/token",
		clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
		clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
		scopes: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
		redirectUri: "http://localhost:1456/auth/callback",
		callbackPort: 1456,
	},
};
