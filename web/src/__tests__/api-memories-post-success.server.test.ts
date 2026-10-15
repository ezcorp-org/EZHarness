/**
 * POST /api/memories success paths (+server.ts).
 *
 * The validation gates live in `api-memories.server.test.ts`. This file mocks
 * the query layer and the embedding generator to pin what a valid save
 * stores: trimmed content, default confidence, the project link (explicit
 * `projectIds` beats a single `projectId`), and the fire-and-forget
 * embedding, whose failure is logged and never fails the save.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const insertMemory = vi.fn();
const updateMemory = vi.fn();
const getMemoryProjectIds = vi.fn();
const generateEmbedding = vi.fn();
const logError = vi.fn();

vi.mock("$server/db/queries/memories", () => ({
	insertMemory,
	updateMemory,
	searchMemories: vi.fn(),
	getMemoryProjectIds,
	getProjectIdsForMemories: vi.fn(),
}));
vi.mock("$server/memory/embeddings", () => ({ generateEmbedding }));
vi.mock("$server/logger", async (importOriginal) => ({
	...(await importOriginal<typeof import("$server/logger")>()),
	logger: { child: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { POST } = await import("../routes/api/memories/+server");

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function post(body: Record<string, unknown>) {
	return POST(
		makeRequestEvent("http://localhost/api/memories", {
			locals: { user },
			request: {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		}),
	);
}

describe("POST /api/memories (success)", () => {
	beforeEach(() => {
		insertMemory.mockReset().mockImplementation(async (m: Record<string, unknown>) => ({ id: "mem-1", ...m }));
		updateMemory.mockReset().mockResolvedValue(undefined);
		getMemoryProjectIds.mockReset().mockResolvedValue([P1]);
		generateEmbedding.mockReset().mockResolvedValue([0.1, 0.2]);
		logError.mockReset();
	});

	test("saves trimmed content with default confidence and links the single project", async () => {
		const res = await post({ content: "  likes tabs  ", category: "preferences", projectId: P1 });

		expect(res.status).toBe(201);
		expect(insertMemory).toHaveBeenCalledWith({
			content: "likes tabs",
			category: "preferences",
			confidence: "medium",
			userId: "u1",
			projectId: P1,
			projectIds: [P1],
		});
		expect(await res.json()).toMatchObject({ id: "mem-1", content: "likes tabs", projectIds: [P1] });
		await vi.waitFor(() => expect(updateMemory).toHaveBeenCalledWith("mem-1", { embedding: [0.1, 0.2] }));
		expect(generateEmbedding).toHaveBeenCalledWith("likes tabs");
	});

	test("explicit projectIds win over projectId; no project means no link", async () => {
		await post({ content: "x", category: "technical", confidence: "high", projectId: P1, projectIds: [P2] });
		expect(insertMemory).toHaveBeenLastCalledWith(
			expect.objectContaining({ confidence: "high", projectId: P1, projectIds: [P2] }),
		);

		await post({ content: "y", category: "technical" });
		const last = insertMemory.mock.calls.at(-1)![0] as Record<string, unknown>;
		expect(last).not.toHaveProperty("projectId");
		expect(last).not.toHaveProperty("projectIds");
	});

	test("an embedding failure is logged and the save still succeeds", async () => {
		generateEmbedding.mockRejectedValue(new Error("model offline"));

		const res = await post({ content: "z", category: "decisions_goals" });

		expect(res.status).toBe(201);
		await vi.waitFor(() =>
			expect(logError).toHaveBeenCalledWith("embedding generation failed", {
				error: "model offline",
				memoryId: "mem-1",
			}),
		);
		expect(updateMemory).not.toHaveBeenCalled();
	});
});
