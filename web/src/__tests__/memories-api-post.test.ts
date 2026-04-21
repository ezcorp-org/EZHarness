import { test, expect, describe, beforeEach, mock } from "bun:test";

// Mock DB queries before importing handler
const mockInsertMemory = mock(() =>
	Promise.resolve({
		id: "mem-new",
		content: "Test memory",
		category: "preferences",
		confidence: "medium",
		status: "active",
		userId: "user-1",
		projectId: null,
		conversationId: null,
		messageIds: null,
		provenance: null,
		embedding: null,
		lastAccessedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}),
);

const mockUpdateMemory = mock(() => Promise.resolve());
const mockSearchMemories = mock(() => Promise.resolve([]));

const mockGetMemoryProjectIds = mock(() => Promise.resolve([] as string[]));
const mockGetProjectIdsForMemories = mock(() => Promise.resolve(new Map<string, string[]>()));

mock.module("$server/db/queries/memories", () => ({
	insertMemory: mockInsertMemory,
	updateMemory: mockUpdateMemory,
	searchMemories: mockSearchMemories,
	// updated for test-regression: handler at routes/api/memories/+server.ts
	// statically imports these two; without them in the mock, Bun's ESM loader
	// validates against the real source module and the test bails out at load
	// time before any assertion runs.
	getMemoryProjectIds: mockGetMemoryProjectIds,
	getProjectIdsForMemories: mockGetProjectIdsForMemories,
}));

mock.module("$server/auth/middleware", () => ({
	requireAuth: () => ({ id: "user-1", email: "test@test.com", name: "Test", role: "member" }),
}));

mock.module("$lib/server/security/api-keys", () => ({
	requireScope: () => null,
}));

mock.module("$server/memory/embeddings", () => ({
	generateEmbedding: mock(() => Promise.resolve(new Array(1536).fill(0))),
}));

// Import handler after mocks
const { POST } = await import("../routes/api/memories/+server");

function makeRequest(body: unknown) {
	return {
		request: new Request("http://localhost/api/memories", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1", email: "test@test.com", name: "Test", role: "member" } },
	} as any;
}

describe("POST /api/memories", () => {
	beforeEach(() => {
		mockInsertMemory.mockClear();
		mockUpdateMemory.mockClear();
	});

	// --- Validation ---

	test("rejects missing content", async () => {
		const res = await POST(makeRequest({ category: "preferences" }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("content is required");
	});

	test("rejects empty string content", async () => {
		const res = await POST(makeRequest({ content: "   ", category: "preferences" }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("content is required");
	});

	test("rejects non-string content", async () => {
		const res = await POST(makeRequest({ content: 123, category: "preferences" }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("content is required");
	});

	test("rejects missing category", async () => {
		const res = await POST(makeRequest({ content: "hello" }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("category must be one of");
	});

	test("rejects invalid category", async () => {
		const res = await POST(makeRequest({ content: "hello", category: "invalid" }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("category must be one of");
	});

	test("rejects invalid confidence", async () => {
		const res = await POST(
			makeRequest({ content: "hello", category: "preferences", confidence: "ultra" }),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("confidence must be one of");
	});

	// --- Valid categories ---

	for (const category of ["preferences", "biographical", "technical", "decisions_goals"]) {
		test(`accepts valid category: ${category}`, async () => {
			const res = await POST(makeRequest({ content: "test", category }));
			expect(res.status).toBe(201);
		});
	}

	// --- Valid confidences ---

	for (const confidence of ["high", "medium", "low"]) {
		test(`accepts valid confidence: ${confidence}`, async () => {
			const res = await POST(
				makeRequest({ content: "test", category: "preferences", confidence }),
			);
			expect(res.status).toBe(201);
		});
	}

	// --- Successful creation ---

	test("creates memory with 201 status", async () => {
		const res = await POST(
			makeRequest({ content: "User likes Vim", category: "preferences", confidence: "high" }),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.id).toBe("mem-new");
	});

	test("trims content before inserting", async () => {
		await POST(makeRequest({ content: "  padded content  ", category: "technical" }));
		expect(mockInsertMemory).toHaveBeenCalledWith(
			expect.objectContaining({ content: "padded content" }),
		);
	});

	test("defaults confidence to medium when omitted", async () => {
		await POST(makeRequest({ content: "test", category: "preferences" }));
		expect(mockInsertMemory).toHaveBeenCalledWith(
			expect.objectContaining({ confidence: "medium" }),
		);
	});

	test("passes userId from auth", async () => {
		await POST(makeRequest({ content: "test", category: "preferences" }));
		expect(mockInsertMemory).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1" }),
		);
	});

	test("passes projectId when provided", async () => {
		await POST(
			makeRequest({ content: "test", category: "preferences", projectId: "proj-1" }),
		);
		expect(mockInsertMemory).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-1" }),
		);
	});

	test("omits projectId when not provided", async () => {
		await POST(makeRequest({ content: "test", category: "preferences" }));
		const call = mockInsertMemory.mock.calls[0] as unknown[];
		const callArgs = call[0] as Record<string, unknown>;
		expect(callArgs).not.toHaveProperty("projectId");
	});

	test("allows undefined confidence (uses default)", async () => {
		const res = await POST(
			makeRequest({ content: "test", category: "biographical", confidence: undefined }),
		);
		expect(res.status).toBe(201);
		expect(mockInsertMemory).toHaveBeenCalledWith(
			expect.objectContaining({ confidence: "medium" }),
		);
	});
});
