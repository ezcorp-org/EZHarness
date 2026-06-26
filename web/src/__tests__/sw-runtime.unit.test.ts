import { test, expect, describe, vi } from "vitest";
import {
	cacheName,
	precacheList,
	classifyRequest,
	cacheFirst,
	onFetch,
	onInstall,
	onActivate,
	PRECACHE_STATIC,
	type FetchEnv,
	type SwManifest,
} from "../lib/sw-runtime";

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeCache {
	store = new Map<string, unknown>();
	addCalls: string[] = [];
	putCalls: Array<[unknown, unknown]> = [];
	addReject = new Set<string>();
	async match(req: unknown): Promise<unknown> {
		return this.store.get(keyOf(req));
	}
	async put(req: unknown, res: unknown): Promise<void> {
		this.store.set(keyOf(req), res);
		this.putCalls.push([req, res]);
	}
	async add(url: string): Promise<void> {
		this.addCalls.push(url);
		if (this.addReject.has(url)) throw new Error(`add failed: ${url}`);
		this.store.set(url, { ok: true });
	}
}

class FakeCaches {
	cache = new FakeCache();
	keysList: string[] = [];
	deleted: string[] = [];
	openedWith: string[] = [];
	async open(name: string): Promise<FakeCache> {
		this.openedWith.push(name);
		return this.cache;
	}
	async keys(): Promise<string[]> {
		return this.keysList;
	}
	async delete(name: string): Promise<boolean> {
		this.deleted.push(name);
		return true;
	}
}

function keyOf(req: unknown): string {
	return typeof req === "string" ? req : (req as { url: string }).url;
}

function envWith(caches: FakeCaches, fetchImpl: typeof fetch): FetchEnv {
	return {
		caches: caches as unknown as CacheStorage,
		fetch: fetchImpl,
		cacheKey: "ezcorp-test",
	};
}

const REQ = (over: Partial<{ method: string; mode: string; url: string }> = {}) => ({
	method: "GET",
	mode: "cors",
	url: "http://o/x",
	...over,
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cacheName", () => {
	test("namespaces by version", () => {
		expect(cacheName("v1")).toBe("ezcorp-v1");
	});
});

describe("precacheList", () => {
	test("includes every build chunk + only the curated static present in files", () => {
		const manifest: SwManifest = {
			version: "v1",
			build: ["/_app/a.js", "/_app/b.js"],
			files: ["/logo.svg", "/unlisted.png"],
		};
		expect(precacheList(manifest)).toEqual(["/_app/a.js", "/_app/b.js", "/logo.svg"]);
	});

	test("honours a custom static allow-list", () => {
		const manifest: SwManifest = { version: "v1", build: [], files: ["/a", "/b"] };
		expect(precacheList(manifest, ["/a"])).toEqual(["/a"]);
	});

	test("PRECACHE_STATIC contains the splash logo", () => {
		expect(PRECACHE_STATIC).toContain("/logo.svg");
	});
});

describe("classifyRequest", () => {
	const origin = "http://o";
	test("bypasses non-GET", () => {
		expect(classifyRequest(REQ({ method: "POST", url: "http://o/_app/immutable/x" }), origin)).toBe(
			"bypass",
		);
	});
	test("bypasses an unparseable URL", () => {
		expect(classifyRequest(REQ({ url: "::::" }), origin)).toBe("bypass");
	});
	test("bypasses cross-origin", () => {
		expect(classifyRequest(REQ({ url: "http://other/_app/immutable/x" }), origin)).toBe("bypass");
	});
	test("bypasses navigations (preserves SSR)", () => {
		expect(classifyRequest(REQ({ mode: "navigate", url: "http://o/anything" }), origin)).toBe(
			"bypass",
		);
	});
	test("bypasses /api/** (preserves auth + streaming)", () => {
		expect(classifyRequest(REQ({ url: "http://o/api/projects" }), origin)).toBe("bypass");
	});
	test("cache-firsts immutable build assets", () => {
		expect(classifyRequest(REQ({ url: "http://o/_app/immutable/chunk.js" }), origin)).toBe(
			"cache-first",
		);
	});
	test("cache-firsts curated static assets", () => {
		expect(classifyRequest(REQ({ url: "http://o/logo.svg" }), origin)).toBe("cache-first");
	});
	test("bypasses other same-origin GETs by default", () => {
		expect(classifyRequest(REQ({ url: "http://o/some/page.png" }), origin)).toBe("bypass");
	});
});

describe("cacheFirst", () => {
	test("returns the cached response without hitting the network", async () => {
		const caches = new FakeCaches();
		const hit = { ok: true, body: "cached" };
		caches.cache.store.set("http://o/_app/immutable/x.js", hit);
		const fetchSpy = vi.fn();
		const res = await cacheFirst({ url: "http://o/_app/immutable/x.js" } as unknown as Request, envWith(caches, fetchSpy as unknown as typeof fetch));
		expect(res).toBe(hit);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("fetches + caches on a miss when the response is ok", async () => {
		const caches = new FakeCaches();
		const clone = { cloned: true };
		const networkRes = { ok: true, clone: () => clone };
		const fetchImpl = vi.fn().mockResolvedValue(networkRes);
		const req = { url: "http://o/_app/immutable/y.js" } as unknown as Request;
		const res = await cacheFirst(req, envWith(caches, fetchImpl as unknown as typeof fetch));
		expect(res).toBe(networkRes);
		expect(caches.cache.putCalls).toEqual([[req, clone]]);
	});

	test("does NOT cache a non-ok response", async () => {
		const caches = new FakeCaches();
		const networkRes = { ok: false, clone: () => ({}) };
		const fetchImpl = vi.fn().mockResolvedValue(networkRes);
		const res = await cacheFirst({ url: "http://o/_app/immutable/z.js" } as unknown as Request, envWith(caches, fetchImpl as unknown as typeof fetch));
		expect(res).toBe(networkRes);
		expect(caches.cache.putCalls).toHaveLength(0);
	});
});

describe("onFetch", () => {
	test("responds for cache-first requests", () => {
		const caches = new FakeCaches();
		caches.cache.store.set("http://o/_app/immutable/x.js", { ok: true });
		const respondWith = vi.fn();
		onFetch(
			{ request: REQ({ url: "http://o/_app/immutable/x.js" }) as unknown as Request, respondWith },
			envWith(caches, (() => {}) as unknown as typeof fetch),
			"http://o",
		);
		expect(respondWith).toHaveBeenCalledTimes(1);
	});

	test("leaves bypass requests to the browser", () => {
		const caches = new FakeCaches();
		const respondWith = vi.fn();
		onFetch(
			{ request: REQ({ mode: "navigate", url: "http://o/page" }) as unknown as Request, respondWith },
			envWith(caches, (() => {}) as unknown as typeof fetch),
			"http://o",
		);
		expect(respondWith).not.toHaveBeenCalled();
	});
});

describe("onInstall", () => {
	test("precaches every url and survives an individual add failure", async () => {
		const caches = new FakeCaches();
		caches.cache.addReject.add("/_app/b.js");
		const manifest: SwManifest = {
			version: "v1",
			build: ["/_app/a.js", "/_app/b.js"],
			files: ["/logo.svg"],
		};
		await expect(
			onInstall(envWith(caches, (() => {}) as unknown as typeof fetch), manifest),
		).resolves.toBeUndefined();
		expect(caches.openedWith).toEqual(["ezcorp-test"]);
		expect(caches.cache.addCalls.sort()).toEqual(["/_app/a.js", "/_app/b.js", "/logo.svg"]);
	});
});

describe("onActivate", () => {
	test("purges stale caches, keeps the current one, then claims", async () => {
		const caches = new FakeCaches();
		caches.keysList = ["ezcorp-old", "ezcorp-current", "other"];
		const claim = vi.fn().mockResolvedValue(undefined);
		await onActivate({ caches: caches as unknown as CacheStorage, keepKey: "ezcorp-current", claim });
		expect(caches.deleted.sort()).toEqual(["ezcorp-old", "other"]);
		expect(claim).toHaveBeenCalledTimes(1);
	});
});
