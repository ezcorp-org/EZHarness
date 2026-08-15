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
			authMethod?: import("../../src/auth/middleware").AuthMethod;
			/**
			 * WHICH `ezk_`/`ezkint_` key authenticated this request, stamped
			 * with `authMethod` in bearer-auth.ts. Absent on a cookie session.
			 * Paired with `authMethod` by `principalId` (`src/auth/principal-id.ts`)
			 * into the identity a parked permission gate is confined to.
			 */
			apiKeyId?: string;
			/**
			 * The verifying key's per-key TOOL POLICY, stamped with
			 * `apiKeyId` in bearer-auth.ts and ONLY when the key row
			 * carries one. Its positive presence is the single signal
			 * every boundary binds on: the route allowlist in
			 * hooks.server.ts, the locked-mode + autopilot refusals on
			 * the run-start routes, and the caller-tool declaration cap.
			 * Absent on a cookie session, on an unpolicied key, and on
			 * an internal `ezkint_` principal — all three unchanged.
			 * See `src/auth/tool-policy.ts`.
			 */
			apiKeyToolPolicy?: import("../../src/auth/tool-policy").ToolPolicy;
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
