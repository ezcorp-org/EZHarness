// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user?: import("../../src/auth/types").AuthUser;
			apiKeyScopes?: import("./lib/server/security/api-keys").ApiKeyScope[];
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
