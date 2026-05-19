/**
 * Round-trip test for the new `card_layout` column on tool_calls.
 *
 * Per canvas-dock-sdk.md §5 unit cases #tool-call-row:
 *   - persistToolCall({cardLayout: "dock"}) writes the column.
 *   - persistToolCall({cardLayout: undefined}) writes NULL — the host
 *     reads NULL as "inline" via shouldRenderInDock (backwards-compat).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();

import { persistToolCall } from "../db/queries/tool-calls";
import { createProject } from "../db/queries/projects";
import { createConversation } from "../db/queries/conversations";
import { createExtension } from "../db/queries/extensions";
import { getDb } from "../db/connection";
import { toolCalls } from "../db/schema";
import { eq } from "drizzle-orm";

let extId = "";
let convId = "";

beforeAll(async () => {
	await setupTestDb();
	const ext = await createExtension({
		name: "test-cardlayout-ext",
		version: "0.0.0",
		source: "test",
		manifest: { schemaVersion: 2, name: "test-cardlayout-ext", version: "0.0.0", entrypoint: "x", author: { name: "t" }, tools: [], permissions: {} } as any,
	});
	extId = ext.id;
	const project = await createProject({ name: "DockTest", path: "/tmp" });
	const conv = await createConversation(project.id, { title: "t" });
	convId = conv.id;
});

afterAll(async () => {
	restoreModuleMocks();
	await closeTestDb();
});

describe("persistToolCall — card_layout round-trip", () => {
	test("cardLayout: 'dock' writes the column (round-trip via SELECT)", async () => {
		const id = "00000000-0000-0000-0000-00000000d0c4";
		await persistToolCall({
			id,
			conversationId: convId,
			messageId: null,
			extensionId: extId,
			toolName: "open-canvas",
			input: { draftId: "d-1" },
			output: { content: [{ type: "text", text: "ok" }] },
			success: true,
			durationMs: 5,
			cardType: "design-canvas",
			cardLayout: "dock",
		});
		const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.id, id));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.cardLayout).toBe("dock");
		expect(rows[0]!.cardType).toBe("design-canvas");
	});

	test("cardLayout omitted writes NULL — pre-existing-row backwards-compat", async () => {
		const id = "00000000-0000-0000-0000-00000000d0c5";
		await persistToolCall({
			id,
			conversationId: convId,
			messageId: null,
			extensionId: extId,
			toolName: "edit_file",
			input: { file_path: "x" },
			output: { content: [] },
			success: true,
			durationMs: 1,
			cardType: "diff",
			// No cardLayout — should land as NULL.
		});
		const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.id, id));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.cardLayout).toBeNull();
	});
});
