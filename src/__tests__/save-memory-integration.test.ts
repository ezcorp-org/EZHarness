import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Mock DB connection at module level BEFORE imports
mockDbConnection();

// Mock embeddings
mock.module("../memory/embeddings", () => ({
	generateEmbedding: () => Promise.resolve(new Array(1536).fill(0)),
}));

import { insertMemory, searchMemories } from "../db/queries/memories";
import { memories, memoryAuditLog, users } from "../db/schema";
import { eq } from "drizzle-orm";

/**
 * Integration tests validating the save-to-memory flow:
 * Chat message content → POST /api/memories → insertMemory → DB row + audit log
 *
 * Tests the same data shape that handleSaveMemory sends from the chat page.
 */
describe("Save memory from chat integration", () => {
	beforeAll(async () => {
		await setupTestDb();
		const db = getTestDb();
		await db.insert(users).values({
			id: "user-chat-1",
			email: "chatuser@test.com",
			name: "Chat User",
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

	test("user message content saved as memory with preferences category", async () => {
		// Simulates: handleSaveMemory({ content: "I prefer dark mode" })
		const memory = await insertMemory({
			content: "I prefer dark mode",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		expect(memory.content).toBe("I prefer dark mode");
		expect(memory.category).toBe("preferences");
		expect(memory.confidence).toBe("medium");
		expect(memory.status).toBe("active");
	});

	test("assistant message content saved as memory", async () => {
		const memory = await insertMemory({
			content: "Based on our discussion, you prefer using Bun over Node.js for all projects.",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		expect(memory.content).toBe("Based on our discussion, you prefer using Bun over Node.js for all projects.");
		expect(memory.id).toBeDefined();
	});

	test("audit log records memory creation from chat save", async () => {
		const memory = await insertMemory({
			content: "User wants TypeScript strict mode",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		const db = getTestDb();
		const logs = await db
			.select()
			.from(memoryAuditLog)
			.where(eq(memoryAuditLog.memoryId, memory.id));

		expect(logs).toHaveLength(1);
		expect(logs[0]!.action).toBe("created");
		expect(logs[0]!.newContent).toBe("User wants TypeScript strict mode");
	});

	test("saved memory is retrievable via search", async () => {
		await insertMemory({
			content: "Always use Bun instead of Node",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		const results = await searchMemories({ userId: "user-chat-1" });
		const found = results.find((m: any) => m.content === "Always use Bun instead of Node");
		expect(found).toBeDefined();
		expect(found!.category).toBe("preferences");
	});

	test("multiple messages saved as separate memories", async () => {
		await insertMemory({
			content: "Prefers functional programming",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		await insertMemory({
			content: "Uses Neovim as primary editor",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		const db = getTestDb();
		const all = await db.select().from(memories);
		expect(all).toHaveLength(2);
		expect(all.map((m) => m.content).sort()).toEqual([
			"Prefers functional programming",
			"Uses Neovim as primary editor",
		]);
	});

	test("message with markdown content preserved verbatim", async () => {
		const markdownContent = "## Key Points\n- Use `bun test` for testing\n- Prefer `Bun.serve()` over express\n```ts\nconst x = 1;\n```";

		const memory = await insertMemory({
			content: markdownContent,
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		expect(memory.content).toBe(markdownContent);
	});

	test("message with special characters preserved", async () => {
		const content = 'Use <script> tags & "quotes" in HTML — don\'t forget!';

		const memory = await insertMemory({
			content,
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		expect(memory.content).toBe(content);
	});

	test("saved memory gets active status by default", async () => {
		const memory = await insertMemory({
			content: "Test active status",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		expect(memory.status).toBe("active");
	});

	test("saved memory has lastAccessedAt set", async () => {
		const before = new Date();
		const memory = await insertMemory({
			content: "Test timestamps",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});
		const after = new Date();

		const accessed = new Date(memory.lastAccessedAt);
		expect(accessed.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
		expect(accessed.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
	});

	test("saved memory without projectId is global", async () => {
		// handleSaveMemory doesn't pass projectId — memory should be global
		const memory = await insertMemory({
			content: "Global preference from chat",
			category: "preferences",
			confidence: "medium",
			userId: "user-chat-1",
		});

		expect(memory.projectId).toBeNull();
	});
});
