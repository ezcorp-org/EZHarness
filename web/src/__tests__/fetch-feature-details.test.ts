import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { fetchFeatureDetails, _resetFeatureDetailsCache } from "../lib/api";

/**
 * Unit tests for `fetchFeatureDetails` — the lazy fetch + cache that
 * powers the chat-history `$feature` chip's hover popover. Stubs
 * `fetch` so we can assert:
 *   - two-step list → per-id GET flow
 *   - successful results cached per (projectId, name)
 *   - cache scoped per project (same name, different project refetches)
 *   - null results NOT cached → renamed/added feature surfaces on next hover
 *   - concurrent hovers coalesce into one round-trip
 *   - graceful nulls on network error or "no project" sentinel
 */

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { calls: FetchCall[]; restore: () => void } {
	const calls: FetchCall[] = [];
	const original = globalThis.fetch;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	globalThis.fetch = (async (input: any, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.url;
		calls.push({ url, init });
		return handler(url, init);
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const LIST_URL = (projectId: string) => `/api/projects/${projectId}/features`;
const DETAIL_URL = (projectId: string, featureId: string) =>
	`/api/projects/${projectId}/features/${featureId}`;

function listOnly(projectId: string) {
	return [
		{ id: "feat-auth", projectId, name: "auth", description: "" },
		{ id: "feat-chat", projectId, name: "chat", description: "Chat slice" },
	];
}

const FILES_FIXTURE = [
	{ relpath: "src/chat/index.ts", source: "scan" as const },
	{ relpath: "src/chat/util.ts", source: "user" as const },
];

describe("fetchFeatureDetails", () => {
	beforeEach(() => {
		_resetFeatureDetailsCache();
	});

	afterEach(() => {
		_resetFeatureDetailsCache();
	});

	test("two-step fetch: list → per-feature GET, returns full detail", async () => {
		const stub = stubFetch((url) => {
			if (url.endsWith(LIST_URL("p1"))) return jsonResponse(listOnly("p1"));
			if (url.endsWith(DETAIL_URL("p1", "feat-chat"))) {
				return jsonResponse({
					id: "feat-chat",
					name: "chat",
					description: "Chat slice",
					files: FILES_FIXTURE,
				});
			}
			throw new Error(`unexpected url: ${url}`);
		});
		try {
			const detail = await fetchFeatureDetails("chat", "p1");
			expect(detail).not.toBeNull();
			expect(detail!.name).toBe("chat");
			expect(detail!.description).toBe("Chat slice");
			expect(detail!.files).toHaveLength(2);
			expect(detail!.files[0]!.relpath).toBe("src/chat/index.ts");
			// Two requests: list, then per-id detail.
			expect(stub.calls).toHaveLength(2);
			expect(stub.calls[0]!.url).toContain(LIST_URL("p1"));
			expect(stub.calls[1]!.url).toContain(DETAIL_URL("p1", "feat-chat"));
		} finally {
			stub.restore();
		}
	});

	test("returns null when no project is active (sentinel `global` and empty string)", async () => {
		// Should NOT hit the network at all — there's no project-scoped
		// feature index without a project.
		const stub = stubFetch(() => {
			throw new Error("should not fetch");
		});
		try {
			expect(await fetchFeatureDetails("chat", "global")).toBeNull();
			expect(await fetchFeatureDetails("chat", "")).toBeNull();
			expect(stub.calls).toHaveLength(0);
		} finally {
			stub.restore();
		}
	});

	test("returns null when name is empty (defensive)", async () => {
		const stub = stubFetch(() => {
			throw new Error("should not fetch");
		});
		try {
			expect(await fetchFeatureDetails("", "p1")).toBeNull();
			expect(stub.calls).toHaveLength(0);
		} finally {
			stub.restore();
		}
	});

	test("returns null when feature name is missing from the list (no detail call)", async () => {
		const stub = stubFetch((url) => {
			if (url.endsWith(LIST_URL("p1"))) return jsonResponse(listOnly("p1"));
			return jsonResponse({}, 500);
		});
		try {
			const detail = await fetchFeatureDetails("does-not-exist", "p1");
			expect(detail).toBeNull();
			// Only the list call — no detail call attempted.
			expect(stub.calls).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});

	test("caches successful resolutions by (projectId, name)", async () => {
		let listHits = 0;
		const stub = stubFetch((url) => {
			if (url.endsWith(LIST_URL("p1"))) {
				listHits++;
				return jsonResponse(listOnly("p1"));
			}
			return jsonResponse({
				id: "feat-chat",
				name: "chat",
				description: "Chat slice",
				files: FILES_FIXTURE,
			});
		});
		try {
			const a = await fetchFeatureDetails("chat", "p1");
			const b = await fetchFeatureDetails("chat", "p1");
			expect(a).toEqual(b!);
			// Second call served entirely from cache — neither list nor detail.
			expect(listHits).toBe(1);
			expect(stub.calls).toHaveLength(2);
		} finally {
			stub.restore();
		}
	});

	test("cache is scoped per project — same name, different project refetches", async () => {
		let calls = 0;
		const stub = stubFetch((url) => {
			calls++;
			if (url.includes("/api/projects/p1/features") && url.endsWith("/features")) {
				return jsonResponse(listOnly("p1"));
			}
			if (url.includes("/api/projects/p2/features") && url.endsWith("/features")) {
				return jsonResponse(listOnly("p2"));
			}
			return jsonResponse({
				id: "feat-chat",
				name: "chat",
				description: url.includes("/p1/") ? "P1 chat" : "P2 chat",
				files: [],
			});
		});
		try {
			const a = await fetchFeatureDetails("chat", "p1");
			const b = await fetchFeatureDetails("chat", "p2");
			expect(a!.description).toBe("P1 chat");
			expect(b!.description).toBe("P2 chat");
			// Each project hits both endpoints once.
			expect(calls).toBe(4);
		} finally {
			stub.restore();
		}
	});

	test("does NOT cache null results — a later add/rename surfaces on the next hover", async () => {
		let listCallNo = 0;
		const stub = stubFetch((url) => {
			if (url.endsWith(LIST_URL("p1"))) {
				listCallNo++;
				if (listCallNo === 1) return jsonResponse([]); // not yet defined
				return jsonResponse(listOnly("p1"));
			}
			return jsonResponse({
				id: "feat-chat",
				name: "chat",
				description: "Chat slice",
				files: FILES_FIXTURE,
			});
		});
		try {
			const first = await fetchFeatureDetails("chat", "p1");
			const second = await fetchFeatureDetails("chat", "p1");
			expect(first).toBeNull();
			expect(second).not.toBeNull();
			expect(second!.name).toBe("chat");
			// Re-hit list (cache miss for null), then hit detail.
			expect(listCallNo).toBe(2);
		} finally {
			stub.restore();
		}
	});

	test("concurrent calls for the same (projectId, name) coalesce into one round-trip", async () => {
		let listResolve: ((r: Response) => void) | null = null;
		let detailResolve: ((r: Response) => void) | null = null;
		const listPending = new Promise<Response>((r) => { listResolve = r; });
		const detailPending = new Promise<Response>((r) => { detailResolve = r; });
		const stub = stubFetch((url) => {
			if (url.endsWith(LIST_URL("p1"))) return listPending;
			return detailPending;
		});
		try {
			const a = fetchFeatureDetails("chat", "p1");
			const b = fetchFeatureDetails("chat", "p1");
			// Only the list request fires while we wait — second caller
			// shares the same inflight promise.
			expect(stub.calls).toHaveLength(1);
			listResolve!(jsonResponse(listOnly("p1")));
			// Microtask flush so the inflight promise can fire the detail call.
			await Promise.resolve();
			await Promise.resolve();
			detailResolve!(
				jsonResponse({
					id: "feat-chat",
					name: "chat",
					description: "Chat slice",
					files: FILES_FIXTURE,
				}),
			);
			const [resA, resB] = await Promise.all([a, b]);
			expect(resA).toEqual(resB!);
			expect(resA!.name).toBe("chat");
			// Still only one list + one detail fired.
			expect(stub.calls).toHaveLength(2);
		} finally {
			stub.restore();
		}
	});

	test("returns null on list-fetch network failure without throwing", async () => {
		const stub = stubFetch(async () => {
			throw new Error("network down");
		});
		try {
			expect(await fetchFeatureDetails("chat", "p1")).toBeNull();
		} finally {
			stub.restore();
		}
	});

	test("returns null on non-OK list response (e.g. 500)", async () => {
		const stub = stubFetch((url) => {
			if (url.endsWith(LIST_URL("p1"))) return jsonResponse({}, 500);
			return jsonResponse({}, 200);
		});
		try {
			expect(await fetchFeatureDetails("chat", "p1")).toBeNull();
			// No detail call when list failed.
			expect(stub.calls).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});

	test("returns null on non-OK detail response (e.g. 404 — feature deleted between list and detail)", async () => {
		const stub = stubFetch((url) => {
			if (url.endsWith(LIST_URL("p1"))) return jsonResponse(listOnly("p1"));
			return jsonResponse({}, 404);
		});
		try {
			expect(await fetchFeatureDetails("chat", "p1")).toBeNull();
			// Both endpoints attempted — list ok, detail 404.
			expect(stub.calls).toHaveLength(2);
		} finally {
			stub.restore();
		}
	});
});
