/// <reference types="@sveltejs/kit" />
import { version, build, files } from "$service-worker";
import {
	cacheName,
	onActivate,
	onFetch,
	onInstall,
	type FetchEnv,
	type FetchEventLike,
	type SwManifest,
} from "$lib/sw-runtime";

// Thin shell: all decision logic lives in `$lib/sw-runtime` (unit-tested). This
// file only wires the worker globals (`self`, `caches`, the `$service-worker`
// manifest) to those handlers — see sw-runtime.ts for the caching policy.
//
// Minimal local interfaces (instead of the ambient `ServiceWorkerGlobalScope`)
// keep this file typecheckable under the app's DOM lib — SvelteKit excludes it
// from the app tsconfig, but the SW shell unit test imports it for coverage,
// which pulls it into the DOM-lib program.

interface ExtendableEventLike {
	waitUntil(promise: Promise<unknown>): void;
}
interface ServiceWorkerLike {
	addEventListener(type: "install" | "activate", handler: (event: ExtendableEventLike) => void): void;
	addEventListener(type: "fetch", handler: (event: FetchEventLike) => void): void;
	skipWaiting(): Promise<void> | void;
	clients: { claim(): Promise<void> };
	location: { origin: string };
}

const sw = self as unknown as ServiceWorkerLike;
const manifest: SwManifest = { version, build, files };
const CACHE_KEY = cacheName(version);
const env: FetchEnv = { caches, fetch: fetch.bind(globalThis), cacheKey: CACHE_KEY };

sw.addEventListener("install", (event) => {
	// Activate immediately, don't wait for existing clients to close.
	sw.skipWaiting();
	event.waitUntil(onInstall(env, manifest));
});

sw.addEventListener("activate", (event) => {
	event.waitUntil(onActivate({ caches, keepKey: CACHE_KEY, claim: () => sw.clients.claim() }));
});

sw.addEventListener("fetch", (event) => {
	onFetch(event, env, sw.location.origin);
});
