// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user?: import("../../src/auth/types").AuthUser;
			apiKeyScopes?: import("./lib/server/security/api-keys").ApiKeyScope[];
			/**
			 * HOW this request authenticated, stamped positively by the auth
			 * site that populated `user` (cookie session in hooks.server.ts,
			 * `ezk_`/`ezkint_` bearer in bearer-auth.ts). `requireSessionAuth`
			 * allowlists `"session"`; anything unstamped is refused. Never
			 * infer the auth method from the absence of `apiKeyScopes` — see
			 * `src/auth/middleware.ts`.
			 */
			authMethod?: import("../../src/auth/types").AuthMethod;
			/**
			 * First-time onboarding stamp, populated by hooks.server.ts on
			 * page navigations after auth succeeds. Null = not yet
			 * onboarded; a Date = stamped at first wizard finish. Routes
			 * downstream of the hook can read this without re-fetching
			 * the user row.
			 */
			onboardedAt?: Date | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			server?: {
				upgrade(request: Request): Promise<void>;
			};
			request?: Request;
		}
	}
}

export {};
