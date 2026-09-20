/** Bun adapter fields exposed on a SvelteKit request event. */
export interface BunRequestTimeoutPlatform {
	server?: { timeout?: (request: Request, seconds: number) => void };
	request?: Request;
}

/**
 * Keep an admitted bounded operation alive when svelte-adapter-bun applies its
 * ordinary response idle timeout. Call this only after route authorization and
 * operation admission; controller and driver time bounds still apply.
 */
export function disableBunRequestIdleTimeout(platform: BunRequestTimeoutPlatform | undefined): boolean {
	if (!platform?.server?.timeout || !platform.request) return false;
	platform.server.timeout(platform.request, 0);
	return true;
}
