import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Mock DB connection at module level BEFORE imports
mockDbConnection();

// Mock embeddings to avoid real API calls
mock.module("../memory/embeddings", () => ({
	generateEmbedding: () => Promise.resolve(new Array(1536).fill(0)),
}));

import { insertMemory, searchMemories } from "../db/queries/memories";
import { memories, memoryAuditLog, users } from "../db/schema";
import { eq } from "drizzle-orm";

describe("Memory creation integration", () => {
	beforeAll(async () => {
		await setupTestDb();
		// Create a test user for FK references
		const db = getTestDb();
		await db.insert(users).values({
			id: "user-int-1",
			email: "inttest@test.com",
			name: "Integration User",
			passwordHash: "fake-hash",
		}).onConflictDoNothing();
	});

	afterAll(async () => {
		await closeTestDb();
		restoreModuleMocks();
	});

	beforeEach(async () => {
		const pglite = getTestPglite();
		await pglite.exec("DELETE FROM memory_audit_log");
		await pglite.exec("DELETE FROM memories");
	});

	test("insertMemory creates a memory row in the database", async () => {
		const memory = await insertMemory({
			content: "User prefers dark mode",
			category: "preferences",
			confidence: "high",
			userId: "user-int-1",
		});

		expect(memory.id).toBeDefined();
		expect(memory.content).toBe("User prefers dark mode");
		expect(memory.category).toBe("preferences");
		expect(memory.confidence).toBe("high");
		expect(memory.status).toBe("active");
		expect(memory.userId).toBe("user-int-1");
	});

	test("insertMemory creates an audit log entry", async () => {
		const memory = await insertMemory({
			content: "User uses Vim",
			category: "technical",
			confidence: "medium",
			userId: "user-int-1",
		});

		const db = getTestDb();
		const logs = await db
			.select()
			.from(memoryAuditLog)
			.where(eq(memoryAuditLog.memoryId, memory.id));

		expect(logs).toHaveLength(1);
		expect(logs[0]!.action).toBe("created");
		expect(logs[0]!.newContent).toBe("User uses Vim");
	});

	test("insertMemory sets default status to active", async () => {
		const memory = await insertMemory({
			content: "test default status",
			category: "biographical",
			confidence: "low",
			userId: "user-int-1",
		});

		expect(memory.status).toBe("active");
	});

	test("insertMemory sets timestamps", async () => {
		const before = new Date();
		const memory = await insertMemory({
			content: "test timestamps",
			category: "preferences",
			confidence: "medium",
			userId: "user-int-1",
		});
		const after = new Date();

		const created = new Date(memory.createdAt);
		expect(created.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
		expect(created.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
	});

	test("insertMemory with projectId stores it", async () => {
		// Create a project first
		const pglite = getTestPglite();
		await pglite.exec(`
			INSERT INTO projects (id, name, path) VALUES ('proj-int-1', 'Int Test', '/tmp/int')
			ON CONFLICT DO NOTHING
		`);

		const memory = await insertMemory({
			content: "project-scoped memory",
			category: "decisions_goals",
			confidence: "high",
			userId: "user-int-1",
			projectId: "proj-int-1",
		});

		expect(memory.projectId).toBe("proj-int-1");
	});

	test("insertMemory without projectId leaves it null", async () => {
		const memory = await insertMemory({
			content: "global memory",
			category: "preferences",
			confidence: "medium",
			userId: "user-int-1",
		});

		expect(memory.projectId).toBeNull();
	});

	test("created memory appears in searchMemories results", async () => {
		await insertMemory({
			content: "Searchable memory content",
			category: "technical",
			confidence: "high",
			userId: "user-int-1",
		});

		const results = await searchMemories({ userId: "user-int-1" });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.some((m: any) => m.content === "Searchable memory content")).toBe(true);
	});

	test("multiple memories for same user all persist", async () => {
		await insertMemory({
			content: "Memory 1",
			category: "preferences",
			confidence: "high",
			userId: "user-int-1",
		});
		await insertMemory({
			content: "Memory 2",
			category: "technical",
			confidence: "low",
			userId: "user-int-1",
		});
		await insertMemory({
			content: "Memory 3",
			category: "biographical",
			confidence: "medium",
			userId: "user-int-1",
		});

		const db = getTestDb();
		const all = await db.select().from(memories);
		expect(all).toHaveLength(3);
	});

	test("each insertMemory generates a unique audit log", async () => {
		await insertMemory({
			content: "First",
			category: "preferences",
			confidence: "medium",
			userId: "user-int-1",
		});
		await insertMemory({
			content: "Second",
			category: "technical",
			confidence: "high",
			userId: "user-int-1",
		});

		const db = getTestDb();
		const logs = await db.select().from(memoryAuditLog);
		expect(logs).toHaveLength(2);
		expect(logs.map((l) => l.newContent).sort()).toEqual(["First", "Second"]);
	});

	test("all four categories can be stored", async () => {
		const categories = ["preferences", "biographical", "technical", "decisions_goals"] as const;
		for (const category of categories) {
			await insertMemory({
				content: `Memory for ${category}`,
				category,
				confidence: "medium",
				userId: "user-int-1",
			});
		}

		const db = getTestDb();
		const all = await db.select().from(memories);
		expect(all).toHaveLength(4);
		const storedCategories = all.map((m) => m.category).sort();
		expect(storedCategories).toEqual([...categories].sort());
	});

	test("all three confidence levels can be stored", async () => {
		const confidences = ["high", "medium", "low"] as const;
		for (const confidence of confidences) {
			await insertMemory({
				content: `Memory with ${confidence} confidence`,
				category: "preferences",
				confidence,
				userId: "user-int-1",
			});
		}

		const db = getTestDb();
		const all = await db.select().from(memories);
		expect(all).toHaveLength(3);
		const storedConfidences = all.map((m) => m.confidence).sort();
		expect(storedConfidences).toEqual([...confidences].sort());
	});
});
