import { test, expect, describe, vi, beforeAll, afterAll } from "vitest";

// Concrete `$service-worker` manifest so we can assert on the precache list.
// (The vitest alias maps the virtual module to a stub; this overrides it.)
vi.mock("$service-worker", () => ({
	version: "test-v",
	build: ["/_app/immutable/chunk-1.js"],
	files: ["/logo.svg", "/manifest.json"],
	prerendered: [],
	base: "",
}));

// ── Fakes for the worker globals ─────────────────────────────────────────────

class FakeCache {
	store = new Map<string, unknown>();
	addCalls: string[] = [];
	async match(req: unknown): Promise<unknown> {
		return this.store.get(String((req as { url: string }).url));
	}
	async put(req: unknown, res: unknown): Promise<void> {
		this.store.set(String((req as { url: string }).url), res);
	}
	async add(url: string): Promise<void> {
		this.addCalls.push(url);
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

type Listener = (event: unknown) => void;
interface WaitUntilEvent {
	waitUntil(p: Promise<unknown>): void;
}

const handlers: Record<string, Listener> = {};
let fakeCaches: FakeCaches;
const skipWaiting = vi.fn();
const claim = vi.fn().mockResolvedValue(undefined);
let origin: string;
let realAdd: typeof self.addEventListener;

async function runWaitUntil(handler: Listener): Promise<void> {
	const waits: Promise<unknown>[] = [];
	const event: WaitUntilEvent = { waitUntil: (p) => waits.push(p) };
	handler(event);
	await Promise.all(waits);
}

beforeAll(async () => {
	fakeCaches = new FakeCaches();
	origin = self.location.origin;
	realAdd = self.addEventListener;
	vi.stubGlobal("caches", fakeCaches);
	Object.assign(self, { skipWaiting, clients: { claim } });
	// Capture every listener the shell registers instead of really wiring it.
	self.addEventListener = ((type: string, listener: Listener) => {
		handlers[type] = listener;
	}) as unknown as typeof self.addEventListener;

	await import("../service-worker");
});

afterAll(() => {
	self.addEventListener = realAdd;
	vi.unstubAllGlobals();
});

describe("service-worker shell", () => {
	test("registers install / activate / fetch listeners", () => {
		expect(typeof handlers.install).toBe("function");
		expect(typeof handlers.activate).toBe("function");
		expect(typeof handlers.fetch).toBe("function");
	});

	test("install: skips waiting and precaches build + curated static", async () => {
		await runWaitUntil(handlers.install);
		expect(skipWaiting).toHaveBeenCalled();
		expect(fakeCaches.openedWith).toContain("ezcorp-test-v");
		expect(fakeCaches.cache.addCalls.sort()).toEqual([
			"/_app/immutable/chunk-1.js",
			"/logo.svg",
			"/manifest.json",
		]);
	});

	test("activate: purges old caches and claims clients", async () => {
		fakeCaches.keysList = ["ezcorp-old", "ezcorp-test-v"];
		await runWaitUntil(handlers.activate);
		expect(fakeCaches.deleted).toEqual(["ezcorp-old"]);
		expect(claim).toHaveBeenCalled();
	});

	test("fetch: responds for a cache-first asset", () => {
		fakeCaches.cache.store.set(`${origin}/_app/immutable/chunk-1.js`, { ok: true });
		const respondWith = vi.fn();
		handlers.fetch({
			request: { method: "GET", mode: "no-cors", url: `${origin}/_app/immutable/chunk-1.js` },
			respondWith,
		});
		expect(respondWith).toHaveBeenCalledTimes(1);
	});

	test("fetch: ignores a navigation (network passthrough)", () => {
		const respondWith = vi.fn();
		handlers.fetch({
			request: { method: "GET", mode: "navigate", url: `${origin}/some/page` },
			respondWith,
		});
		expect(respondWith).not.toHaveBeenCalled();
	});
});
