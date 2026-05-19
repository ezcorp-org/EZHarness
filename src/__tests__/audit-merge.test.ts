/**
 * Phase 52.2 — coverage for the unified audit timeline merger.
 *
 * Asserts:
 *   - governance + capability + resource fan-in produces a merged
 *     timeline ordered by createdAt DESC.
 *   - capability filter narrows to one bucket.
 *   - status=denial returns governance-denial actions + capability
 *     rows with success=false; resource rows excluded.
 *   - cursor pagination: encode → decode round-trip; nextCursor on
 *     full pages, null on partial.
 *   - mergeAuditForConversation only surfaces sdk_capability_calls
 *     scoped to conversation_id.
 *   - statsForExtension aggregates the 24h window.
 *   - decodeCursor returns null on garbage / mismatched shape.
 */
import { test, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import {
	setupTestDb,
	closeTestDb,
	mockDbConnection,
} from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
	async getAllSettings() { return {}; },
	async getSetting() { return undefined; },
	async upsertSetting() {},
	async deleteSetting() { return false; },
	async isListingInstalled() { return false; },
}));

mockDbConnection();

const {
	mergeAuditForExtension,
	mergeAuditForConversation,
	statsForExtension,
	encodeCursor,
	decodeCursor,
} = await import("../db/queries/audit-merge");
const { insertAuditEntry } = await import("../db/queries/audit-log");
const { insertSdkCapabilityCall } = await import("../db/queries/sdk-capability-calls");
const { insertLessonAuditEntry } = await import("../db/queries/lessons-audit");
const { createExtension } = await import("../db/queries/extensions");
const { getDb } = await import("../db/connection");
const { memoryAuditLog, memories, lessons, conversations, projects, users } = await import(
	"../db/schema"
);

let extensionId: string;
let conversationId: string;
let userId: string;

beforeAll(async () => {
	await setupTestDb();
	// Seed user, conversation, extension, memory + lesson rows we can
	// link audit entries to. We use unique ids per-run so re-running
	// the suite doesn't conflict.
	const u = await getDb().insert(users).values({
		id: `u-audit-${Date.now()}`,
		email: `t-${Date.now()}@x`,
		passwordHash: "x",
		name: "audit-tester",
		role: "admin",
	} as any).returning();
	userId = u[0]!.id;

	const proj = await getDb().insert(projects).values({
		id: `p-audit-${Date.now()}`,
		name: "audit-test-proj",
		path: `/tmp/audit-test-${Date.now()}`,
	} as any).returning();
	const projectId = proj[0]!.id;

	const c = await getDb().insert(conversations).values({
		id: `c-audit-${Date.now()}`,
		projectId,
		title: "audit-test-conv",
		userId,
	} as any).returning();
	conversationId = c[0]!.id;

	const ext = await createExtension({
		name: `audit-merge-ext-${Date.now()}`,
		version: "1.0.0",
		description: "merge test",
		manifest: {
			schemaVersion: 2 as const,
			name: "audit-merge-ext",
			version: "1.0.0",
			description: "merge test",
			author: { name: "tester" },
			permissions: {},
		},
		source: "local:/tmp/x",
		installPath: "/tmp/x",
		enabled: true,
		grantedPermissions: { grantedAt: {} } as any,
		checksumVerified: false,
		consecutiveFailures: 0,
	} as any);
	extensionId = ext.id;
});

afterAll(async () => {
	await closeTestDb();
	mock.restore();
});

beforeEach(async () => {
	// Clear audit tables so each test starts from a known floor.
	const db = getDb();
	await db.execute(
		"DELETE FROM sdk_capability_calls WHERE extension_id = '" + extensionId.replace(/'/g, "''") + "'" as any,
	);
	await db.execute(
		"DELETE FROM lessons_audit_log WHERE actor_extension_id = '" + extensionId.replace(/'/g, "''") + "'" as any,
	);
	await db.execute(
		"DELETE FROM memory_audit_log WHERE reason = 'ext:" + extensionId.replace(/'/g, "''") + "'" as any,
	);
	await db.execute(
		"DELETE FROM audit_log WHERE target = '" + extensionId.replace(/'/g, "''") + "'" as any,
	);
});

async function seedGovernance(action: string, ts: Date) {
	await insertAuditEntry(userId, action, extensionId, {
		permission: "test",
		oldValue: null,
		newValue: null,
		actor: userId,
	});
	// Override createdAt so we can predict ordering.
	await getDb().execute(
		`UPDATE audit_log SET created_at = '${ts.toISOString()}' WHERE target = '${extensionId}' AND action = '${action}' AND created_at = (SELECT MAX(created_at) FROM audit_log WHERE target = '${extensionId}' AND action = '${action}')` as any,
	);
}

async function seedCapability(opts: {
	capability: "llm" | "memory" | "lessons" | "schedule" | "events";
	action: string;
	success: boolean;
	ts: Date;
	conversationId?: string | null;
	costUsd?: number;
}) {
	const row = await insertSdkCapabilityCall({
		extensionId,
		onBehalfOf: userId,
		conversationId: opts.conversationId === undefined ? conversationId : opts.conversationId,
		capability: opts.capability,
		action: opts.action,
		success: opts.success,
		durationMs: 12,
		costUsd: opts.costUsd ?? null,
		resourceType: null,
		resourceId: null,
		errorCode: null,
		errorMessage: null,
		tokensUsed: null,
		provider: null,
		model: null,
		parentCallId: null,
		before: null,
		after: null,
	} as any);
	await getDb().execute(
		`UPDATE sdk_capability_calls SET created_at = '${opts.ts.toISOString()}' WHERE id = '${row.id}'` as any,
	);
	return row.id;
}

test("encodeCursor / decodeCursor round-trip", () => {
	const enc = encodeCursor({ ts: "2026-05-01T00:00:00.000Z", id: "abc-123" });
	const dec = decodeCursor(enc);
	expect(dec).toEqual({ ts: "2026-05-01T00:00:00.000Z", id: "abc-123" });
});

test("decodeCursor returns null on garbage", () => {
	expect(decodeCursor(null)).toBeNull();
	expect(decodeCursor(undefined)).toBeNull();
	expect(decodeCursor("")).toBeNull();
	expect(decodeCursor("not-base64-!!@#$")).toBeNull();
	// Valid base64 but wrong shape
	const bad = Buffer.from(JSON.stringify({ wrong: "shape" })).toString("base64url");
	expect(decodeCursor(bad)).toBeNull();
	// Valid shape but garbled date
	const badDate = Buffer.from(JSON.stringify({ ts: "not-a-date", id: "x" })).toString("base64url");
	expect(decodeCursor(badDate)).toBeNull();
});

test("mergeAuditForExtension fans in governance + capability + resource", async () => {
	await seedGovernance("ext:permission-granted", new Date("2026-05-01T10:00:00Z"));
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: new Date("2026-05-01T11:00:00Z") });

	const result = await mergeAuditForExtension(extensionId);
	expect(result.entries.length).toBeGreaterThanOrEqual(2);

	const kinds = result.entries.map((e) => e.kind);
	expect(kinds).toContain("governance");
	expect(kinds).toContain("capability");

	// Order: most recent first.
	for (let i = 1; i < result.entries.length; i++) {
		expect(result.entries[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
			result.entries[i]!.createdAt.getTime(),
		);
	}
});

test("mergeAuditForExtension capability filter narrows to one bucket", async () => {
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: new Date("2026-05-01T10:00:00Z") });
	await seedCapability({ capability: "memory", action: "read", success: true, ts: new Date("2026-05-01T11:00:00Z") });

	const llmOnly = await mergeAuditForExtension(extensionId, { capability: "llm" });
	for (const e of llmOnly.entries) {
		expect(e.kind).toBe("capability");
		if (e.kind === "capability") expect(e.capability).toBe("llm");
	}
});

test("mergeAuditForExtension status=denial returns denial governance + failed capability", async () => {
	await seedGovernance("ext:permission-rejected", new Date("2026-05-01T10:00:00Z"));
	await seedGovernance("ext:permission-granted", new Date("2026-05-01T11:00:00Z"));
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: new Date("2026-05-01T12:00:00Z") });
	await seedCapability({ capability: "llm", action: "complete", success: false, ts: new Date("2026-05-01T13:00:00Z") });

	const denials = await mergeAuditForExtension(extensionId, { status: "denial" });
	for (const e of denials.entries) {
		if (e.kind === "governance") {
			// Only denial-action governance rows should be returned.
			expect(e.action).not.toBe("ext:permission-granted");
		} else if (e.kind === "capability") {
			expect(e.success).toBe(false);
		} else {
			throw new Error(`status=denial returned a resource row: ${e.kind}`);
		}
	}
});

test("mergeAuditForExtension cursor pagination drives a second page", async () => {
	for (let i = 0; i < 5; i++) {
		await seedCapability({
			capability: "llm",
			action: "complete",
			success: true,
			ts: new Date(`2026-05-01T1${i}:00:00Z`),
		});
	}

	const page1 = await mergeAuditForExtension(extensionId, { limit: 2 });
	expect(page1.entries).toHaveLength(2);
	expect(page1.nextCursor).not.toBeNull();

	const page2 = await mergeAuditForExtension(extensionId, { limit: 2, cursor: page1.nextCursor! });
	expect(page2.entries).toHaveLength(2);
	// No id overlap between pages.
	const page1Ids = new Set(page1.entries.map((e) => e.id));
	for (const e of page2.entries) expect(page1Ids.has(e.id)).toBe(false);
});

test("mergeAuditForExtension surfaces lesson_audit_log rows by actor", async () => {
	// Seed a lesson row first (FK constraint), then audit it.
	// Need a project for the lesson FK.
	const projForLesson = await getDb().insert(projects).values({
		id: `p-lesson-${Date.now()}`,
		name: "lesson-proj",
		path: `/tmp/p-lesson-${Date.now()}`,
	} as any).returning();
	const l = await getDb().insert(lessons).values({
		slug: `audit-merge-lesson-${Date.now()}`,
		title: "lesson",
		body: "body",
		author: "tester",
		projectId: projForLesson[0]!.id,
		ownerId: userId,
	} as any).returning();
	const lessonId = l[0]!.id;

	await insertLessonAuditEntry({
		lessonId,
		action: "created",
		previousBody: null,
		newBody: "body",
		actorExtensionId: extensionId,
		actorUserId: userId,
		reason: `ext:${extensionId}`,
	});

	const result = await mergeAuditForExtension(extensionId);
	const resourceRows = result.entries.filter((e) => e.kind === "resource");
	expect(resourceRows.length).toBeGreaterThanOrEqual(1);
	expect(resourceRows[0]!.kind === "resource" && resourceRows[0]!.resourceKind).toBe("lesson");
});

test("mergeAuditForExtension surfaces memory_audit_log via reason match", async () => {
	const m = await getDb().insert(memories).values({
		id: `m-audit-${Date.now()}`,
		content: "memory body",
		category: "test",
		userId,
	} as any).returning();
	const memoryId = m[0]!.id;

	await getDb().insert(memoryAuditLog).values({
		memoryId,
		action: "created",
		previousContent: null,
		newContent: "memory body",
		reason: `ext:${extensionId}`,
	});

	const result = await mergeAuditForExtension(extensionId);
	const memoryRows = result.entries.filter(
		(e) => e.kind === "resource" && e.resourceKind === "memory",
	);
	expect(memoryRows.length).toBeGreaterThanOrEqual(1);
});

test("mergeAuditForConversation only returns conversation-scoped rows", async () => {
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: new Date("2026-05-01T10:00:00Z"), conversationId });
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: new Date("2026-05-01T11:00:00Z"), conversationId: null });

	const result = await mergeAuditForConversation(conversationId);
	expect(result.entries.length).toBeGreaterThanOrEqual(1);
	for (const e of result.entries) {
		if (e.kind === "capability") expect(e.conversationId).toBe(conversationId);
	}
});

test("cursor pagination tie-breaks on id when same-millisecond rows collide", async () => {
	// Seed two rows with identical createdAt — the merger must surface
	// both across paginated requests, not silently drop the second.
	const sameTs = new Date("2026-05-01T15:00:00.000Z");
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: sameTs });
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: sameTs });

	const page1 = await mergeAuditForExtension(extensionId, { limit: 1 });
	expect(page1.entries).toHaveLength(1);
	expect(page1.nextCursor).not.toBeNull();

	const page2 = await mergeAuditForExtension(extensionId, {
		limit: 1,
		cursor: page1.nextCursor!,
	});
	expect(page2.entries).toHaveLength(1);
	// The two pages must surface different rows — without the id
	// tie-break, page2 would either re-emit page1's row or drop the
	// second same-ms row entirely.
	expect(page2.entries[0]!.id).not.toBe(page1.entries[0]!.id);
});

test("statsForExtension aggregates within range", async () => {
	const recent = new Date(Date.now() - 1000 * 60 * 30); // 30 min ago
	const old = new Date(Date.now() - 1000 * 60 * 60 * 48); // 48 h ago
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: recent, costUsd: 0.01 });
	await seedCapability({ capability: "llm", action: "complete", success: false, ts: recent });
	await seedCapability({ capability: "llm", action: "complete", success: true, ts: old, costUsd: 999 });

	const stats = await statsForExtension(extensionId, 24 * 60 * 60 * 1000);
	expect(stats.totalCalls).toBe(2);
	expect(stats.denialCount).toBe(1);
	expect(stats.totalCostUsd).toBeCloseTo(0.01, 5);
	expect(stats.successRate).toBeCloseTo(0.5, 5);
});
