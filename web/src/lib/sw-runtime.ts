/**
 * Service-worker runtime logic (environment-injected, unit-testable).
 *
 * Extracted from `service-worker.ts` so every branch can be exercised under
 * vitest with fake `Cache`/`fetch` — the real SW globals only exist in the
 * worker thread. The shell wires the live `self` / `caches` / `$service-worker`
 * manifest to these handlers.
 *
 * Caching policy (regression-safe for an SSR + auth + SSE app):
 *   - NAVIGATIONS, `/api/**`, non-GET, cross-origin → **bypass** (network
 *     only). The SW never serves an HTML shell or an API response, so SSR,
 *     `hooks.server.ts` auth/onboarding redirects, and streaming stay intact.
 *   - same-origin `/_app/immutable/**` + a curated static set → **cache-first**.
 *     These are content-hashed (immutable), so a stale serve is impossible:
 *     a new deploy ships new hashes (cache miss → fetched fresh) and the old
 *     versioned cache is purged on `activate`.
 */

export interface SwManifest {
	/** Build version string (from `$service-worker`). */
	version: string;
	/** App chunk URLs (content-hashed `/_app/immutable/…`). */
	build: string[];
	/** Files served from `static/`. */
	files: string[];
}

/**
 * Small static files worth precaching (used on first paint / by the splash).
 * Anything not listed (e.g. large model weights under `static/`) is left to
 * the network.
 */
export const PRECACHE_STATIC: readonly string[] = [
	"/logo.svg",
	"/manifest.json",
	"/favicon.ico",
	"/favicon-192.png",
	"/favicon-512.png",
];

/** Versioned cache name — bumps on every deploy so `activate` can purge old. */
export function cacheName(version: string): string {
	return `ezcorp-${version}`;
}

/** Precache URL list: all app chunks + the curated static subset present. */
export function precacheList(
	manifest: SwManifest,
	staticAllow: readonly string[] = PRECACHE_STATIC,
): string[] {
	const fileSet = new Set(manifest.files);
	const staticHits = staticAllow.filter((f) => fileSet.has(f));
	return [...manifest.build, ...staticHits];
}

export type RequestClass = "bypass" | "cache-first";

export interface ClassifiableRequest {
	method: string;
	mode: string;
	url: string;
}

/**
 * Decide how to handle a fetch. `origin` is the SW's own origin. Defaults to
 * `bypass` for everything dynamic; only immutable, content-hashed assets are
 * served cache-first.
 */
export function classifyRequest(request: ClassifiableRequest, origin: string): RequestClass {
	if (request.method !== "GET") return "bypass";
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return "bypass";
	}
	if (url.origin !== origin) return "bypass";
	if (request.mode === "navigate") return "bypass";
	if (url.pathname.startsWith("/api/")) return "bypass";
	if (url.pathname.startsWith("/_app/immutable/")) return "cache-first";
	if (PRECACHE_STATIC.includes(url.pathname)) return "cache-first";
	return "bypass";
}

export interface FetchEnv {
	caches: CacheStorage;
	fetch: typeof fetch;
	/** Result of `cacheName(version)`. */
	cacheKey: string;
}

/** Serve from cache, falling back to network and populating the cache. */
export async function cacheFirst(request: Request, env: FetchEnv): Promise<Response> {
	const cache = await env.caches.open(env.cacheKey);
	const hit = await cache.match(request);
	if (hit) return hit;
	const res = await env.fetch(request);
	if (res.ok) {
		await cache.put(request, res.clone());
	}
	return res;
}

/** Minimal shape of the `fetch` event the shell forwards to us. */
export interface FetchEventLike {
	request: Request;
	respondWith(response: Promise<Response>): void;
}

/**
 * `fetch` handler. Only calls `respondWith` for cache-first requests; bypass
 * requests are left untouched so the browser performs its default network
 * fetch (preserving SSR, auth, and streaming).
 */
export function onFetch(event: FetchEventLike, env: FetchEnv, origin: string): void {
	if (classifyRequest(event.request, origin) === "cache-first") {
		event.respondWith(cacheFirst(event.request, env));
	}
}

/**
 * `install` handler: precache the build + curated static. Resilient — one
 * missing asset must not abort the whole install, so each URL is added
 * individually and failures are swallowed.
 */
export async function onInstall(env: FetchEnv, manifest: SwManifest): Promise<void> {
	const cache = await env.caches.open(env.cacheKey);
	await Promise.all(
		precacheList(manifest).map((url) => cache.add(url).catch(() => undefined)),
	);
}

/** `activate` handler: drop every cache except the current version, then claim. */
export async function onActivate(env: {
	caches: CacheStorage;
	keepKey: string;
	claim: () => Promise<void>;
}): Promise<void> {
	const keys = await env.caches.keys();
	await Promise.all(keys.filter((k) => k !== env.keepKey).map((k) => env.caches.delete(k)));
	await env.claim();
}
