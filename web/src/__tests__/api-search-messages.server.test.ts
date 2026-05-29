/**
 * Server-handler unit tests for /api/search/messages/+server.ts.
 *
 * Phase 65 Wave 2 — the hybrid/keyword/semantic message-search route. Covers:
 *  - SRCH-01: auth (401) + read-scope (403) gate + missing projectId (400) + happy envelope
 *  - SRCH-03: mode default 'hybrid' + keyword/semantic threading + unknown mode → 400
 *  - locked edge cases: <2-char query → empty envelope; limit/offset clamp to [1,50]/[0,∞)
 *  - SRCH-08: embedder-down (pre-check OR transient throw) degrades hybrid/semantic to
 *    keyword (degraded:true, servedMode:'keyword'); keyword is never degraded.
 *
 * The query module + embeddings are mocked at the import boundary so this stays off PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/message-search", () => ({
	searchMessages: vi.fn(),
	RRF_K: 60,
}));

vi.mock("$server/memory/embeddings", () => ({
	isEmbeddingReady: vi.fn(),
	generateEmbedding: vi.fn(),
}));

const { searchMessages } = await import("$server/db/queries/message-search");
const { isEmbeddingReady, generateEmbedding } = await import(
	"$server/memory/embeddings"
);
const { GET } = await import("../routes/api/search/messages/+server");

function makeEvent(opts: {
	href?: string;
	locals?: Record<string, unknown>;
}) {
	return {
		url: new URL(opts.href ?? "http://localhost/api/search/messages"),
		locals: opts.locals ?? {},
		request: new Request("http://localhost/api/search/messages"),
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		res = await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res!.status).toBe(status);
	return res!;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

/** Build the search URL with sensible defaults; override via opts. */
function href(opts: {
	projectId?: string | null;
	q?: string | null;
	mode?: string;
	limit?: string;
	offset?: string;
} = {}): string {
	const p = new URLSearchParams();
	if (opts.projectId !== null)
		p.set("projectId", opts.projectId ?? PROJECT_ID);
	if (opts.q !== null) p.set("q", opts.q ?? "hello world");
	if (opts.mode !== undefined) p.set("mode", opts.mode);
	if (opts.limit !== undefined) p.set("limit", opts.limit);
	if (opts.offset !== undefined) p.set("offset", opts.offset);
	return `http://localhost/api/search/messages?${p.toString()}`;
}

beforeEach(() => {
	vi.mocked(searchMessages).mockReset();
	vi.mocked(isEmbeddingReady).mockReset();
	vi.mocked(generateEmbedding).mockReset();
	// Default: embedder healthy, returns a vector.
	vi.mocked(searchMessages).mockResolvedValue([]);
	vi.mocked(isEmbeddingReady).mockReturnValue(true);
	vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
});

describe("GET /api/search/messages — SRCH-01 auth/scope/validation", () => {
	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent({ href: href() })),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 403 when API-key scope lacks 'read'", async () => {
		const res = await GET(
			makeEvent({ href: href(), locals: { user, apiKeyScopes: ["chat"] } }),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
	});

	test("returns 400 when projectId is missing", async () => {
		const res = await GET(
			makeEvent({ href: href({ projectId: null }), locals: { user } }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("happy path: 200 envelope { hits, degraded, requestedMode, servedMode }", async () => {
		const hit = {
			conversationId: "c1",
			conversationTitle: "First",
			messageId: "m1",
			role: "user",
			createdAt: new Date().toISOString(),
			snippet: "<mark>hello</mark>",
			matchType: "both",
			rankLexical: 1,
			rankSemantic: 1,
			score: 0.5,
		};
		vi.mocked(searchMessages).mockResolvedValue([hit] as any);
		const res = await GET(makeEvent({ href: href(), locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			hits: [hit],
			degraded: false,
			requestedMode: "hybrid",
			servedMode: "hybrid",
		});
		expect(vi.mocked(searchMessages)).toHaveBeenCalledTimes(1);
		const arg = vi.mocked(searchMessages).mock.calls[0]![0];
		expect(arg).toMatchObject({
			projectId: PROJECT_ID,
			query: "hello world",
			mode: "hybrid",
			userId: user.id,
		});
		expect(arg.queryEmbedding).toEqual([0.1, 0.2, 0.3]);
	});
});

describe("GET /api/search/messages — SRCH-03 mode threading", () => {
	test("mode omitted → requestedMode 'hybrid' (default)", async () => {
		const res = await GET(makeEvent({ href: href(), locals: { user } }));
		const body = (await res.json()) as { requestedMode: string };
		expect(body.requestedMode).toBe("hybrid");
		expect(vi.mocked(searchMessages).mock.calls[0]![0].mode).toBe("hybrid");
	});

	test("mode=keyword threaded to searchMessages, never degraded, no embedding", async () => {
		vi.mocked(isEmbeddingReady).mockReturnValue(false);
		const res = await GET(
			makeEvent({ href: href({ mode: "keyword" }), locals: { user } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.requestedMode).toBe("keyword");
		expect(body.servedMode).toBe("keyword");
		expect(body.degraded).toBe(false);
		const arg = vi.mocked(searchMessages).mock.calls[0]![0];
		expect(arg.mode).toBe("keyword");
		expect(arg.queryEmbedding).toBeNull();
		expect(vi.mocked(generateEmbedding)).not.toHaveBeenCalled();
	});

	test("mode=semantic threaded to searchMessages with embedding", async () => {
		const res = await GET(
			makeEvent({ href: href({ mode: "semantic" }), locals: { user } }),
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.requestedMode).toBe("semantic");
		expect(body.servedMode).toBe("semantic");
		expect(body.degraded).toBe(false);
		expect(vi.mocked(searchMessages).mock.calls[0]![0].mode).toBe("semantic");
	});

	test("mode=garbage → 400 (zod enum)", async () => {
		const res = await GET(
			makeEvent({ href: href({ mode: "garbage" }), locals: { user } }),
		);
		expect(res.status).toBe(400);
	});
});

describe("GET /api/search/messages — locked edge cases", () => {
	test("q='a' (sub-2-char) → 200 empty-hits envelope, not degraded", async () => {
		const res = await GET(
			makeEvent({ href: href({ q: "a" }), locals: { user } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.hits).toEqual([]);
		expect(body.degraded).toBe(false);
		expect(body.requestedMode).toBe("hybrid");
	});

	test("whitespace-only query → 200 empty-hits envelope", async () => {
		const res = await GET(
			makeEvent({ href: href({ q: "   " }), locals: { user } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.hits).toEqual([]);
		expect(body.degraded).toBe(false);
	});

	test("limit=999 → clamped to 50", async () => {
		await GET(
			makeEvent({ href: href({ limit: "999" }), locals: { user } }),
		);
		expect(vi.mocked(searchMessages).mock.calls[0]![0].limit).toBe(50);
	});

	test("limit=-5 → clamped to 1", async () => {
		await GET(makeEvent({ href: href({ limit: "-5" }), locals: { user } }));
		expect(vi.mocked(searchMessages).mock.calls[0]![0].limit).toBe(1);
	});

	test("offset=-3 → clamped to 0", async () => {
		await GET(makeEvent({ href: href({ offset: "-3" }), locals: { user } }));
		expect(vi.mocked(searchMessages).mock.calls[0]![0].offset).toBe(0);
	});

	test("limit/offset omitted → 20 / 0 defaults", async () => {
		await GET(makeEvent({ href: href(), locals: { user } }));
		const arg = vi.mocked(searchMessages).mock.calls[0]![0];
		expect(arg.limit).toBe(20);
		expect(arg.offset).toBe(0);
	});
});

describe("GET /api/search/messages — SRCH-08 degraded fallback", () => {
	test("mode=hybrid, embedder not ready → keyword + degraded:true", async () => {
		vi.mocked(isEmbeddingReady).mockReturnValue(false);
		const res = await GET(makeEvent({ href: href(), locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.degraded).toBe(true);
		expect(body.servedMode).toBe("keyword");
		expect(body.requestedMode).toBe("hybrid");
		const arg = vi.mocked(searchMessages).mock.calls[0]![0];
		expect(arg.mode).toBe("keyword");
		expect(arg.queryEmbedding).toBeNull();
		expect(vi.mocked(generateEmbedding)).not.toHaveBeenCalled();
	});

	test("mode=semantic, embedder not ready → keyword + degraded:true", async () => {
		vi.mocked(isEmbeddingReady).mockReturnValue(false);
		const res = await GET(
			makeEvent({ href: href({ mode: "semantic" }), locals: { user } }),
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.degraded).toBe(true);
		expect(body.servedMode).toBe("keyword");
		expect(body.requestedMode).toBe("semantic");
		expect(vi.mocked(searchMessages).mock.calls[0]![0].mode).toBe("keyword");
	});

	test("mode=hybrid, embedder ready but generateEmbedding throws → degraded:true keyword", async () => {
		vi.mocked(isEmbeddingReady).mockReturnValue(true);
		vi.mocked(generateEmbedding).mockRejectedValue(new Error("boom"));
		const res = await GET(makeEvent({ href: href(), locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.degraded).toBe(true);
		expect(body.servedMode).toBe("keyword");
		const arg = vi.mocked(searchMessages).mock.calls[0]![0];
		expect(arg.mode).toBe("keyword");
		expect(arg.queryEmbedding).toBeNull();
	});

	test("mode=keyword, embedder not ready → degraded:false, generateEmbedding not called", async () => {
		vi.mocked(isEmbeddingReady).mockReturnValue(false);
		const res = await GET(
			makeEvent({ href: href({ mode: "keyword" }), locals: { user } }),
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.degraded).toBe(false);
		expect(body.servedMode).toBe("keyword");
		expect(vi.mocked(isEmbeddingReady)).not.toHaveBeenCalled();
		expect(vi.mocked(generateEmbedding)).not.toHaveBeenCalled();
	});
});
