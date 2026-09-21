/**
 * Pure logic for UnsandboxedExtensionsBanner. Lifted out of the Svelte file
 * so it is unit-tested bun-side without a component-mounting framework —
 * the same split UpdateBanner uses.
 */

/** The exact `extensionRunner` value `/api/auth/me` reports for the unsandboxed mode. */
export const UNSANDBOXED_RUNNER_MODE = "trusted-local";

/**
 * True only for the exact mode string. `null`/`undefined` (not fetched yet,
 * or an older server that does not report it), `"isolated"`, and anything
 * unexpected all hide the banner: it must never show on a sandboxed host,
 * and a missing field is not evidence of the dangerous mode.
 */
export function shouldShowUnsandboxedBanner(mode: string | null | undefined): boolean {
	return mode === UNSANDBOXED_RUNNER_MODE;
}
