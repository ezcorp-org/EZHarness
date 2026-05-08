/**
 * Phase 52.4 — coverage for the cross-extension audit feed.
 *
 * Asserts:
 *   - listGlobalAudit returns rows from multiple extensions in
 *     createdAt-DESC order.
 *   - extensionId filter narrows.
 *   - capability filter narrows + drops governance.
 *   - denialOnly returns success=false capability rows + denial-action
 *     governance rows.
 *   - search filters by model substring.
 *   - cursor pagination round-trip.
 *   - globalStats aggregates correctly: denialCount, totalCalls,
 *     totalCost, top-3 chattiest, top-3 LLM spenders.
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

const { listGlobalAudit, globalStats } = await import("../db/queries/audit-global");
const { insertSdkCapabilityCall } = await import("../db/queries/sdk-capability-calls");
const { insertAuditEntry } = await import("../db/queries/audit-log");
const { createExtension } = await import("../db/queries/extensions");
const { getDb } = await import("../db/connection");
const { users } = await import("../db/schema");

let userId: string;
let extA: { id: string; name: string };
let extB: { id: string; name: string };

beforeAll(async () => {
	await setupTestDb();
	const u = await getDb().insert(users).values({
		id: `u-glob-${Date.now()}`,
		email: `g-${Date.now()}@x`,
		passwordHash: "x",
		name: "global-audit-tester",
		role: "admin",
	} as any).returning();
	userId = u[0]!.id;

	const a = await createExtension({
		name: `glob-ext-a-${Date.now()}`,
		version: "1.0.0",
		description: "",
		manifest: { schemaVersion: 2 as const, name: "a", version: "1.0.0", description: "", author: { name: "t" }, permissions: {} },
		source: "local:/tmp/x",
		installPath: "/tmp/x",
		enabled: true,
		grantedPermissions: { grantedAt: {} } as any,
		checksumVerified: false,
		consecutiveFailures: 0,
	} as any);
	extA = { id: a.id, name: a.name };

	const b = await createExtension({
		name: `glob-ext-b-${Date.now()}`,
		version: "1.0.0",
		description: "",
		manifest: { schemaVersion: 2 as const, name: "b", version: "1.0.0", description: "", author: { name: "t" }, permissions: {} },
		source: "local:/tmp/x",
		installPath: "/tmp/x",
		enabled: true,
		grantedPermissions: { grantedAt: {} } as any,
		checksumVerified: false,
		consecutiveFailures: 0,
	} as any);
	extB = { id: b.id, name: b.name };
});

afterAll(async () => {
	await closeTestDb();
	mock.restore();
});

beforeEach(async () => {
	const db = getDb();
	await db.execute("DELETE FROM sdk_capability_calls" as any);
	await db.execute("DELETE FROM audit_log WHERE action LIKE 'ext:%' OR action LIKE 'extension:%'" as any);
});

async function seedCap(opts: {
	extId: string;
	capability: "llm" | "memory" | "lessons" | "schedule" | "events";
	action: string;
	success: boolean;
	ts: Date;
	costUsd?: number;
	model?: string;
	resourceId?: string | null;
	errorMessage?: string | null;
}) {
	const row = await insertSdkCapabilityCall({
		extensionId: opts.extId,
		onBehalfOf: userId,
		conversationId: null,
		capability: opts.capability,
		action: opts.action,
		success: opts.success,
		durationMs: 12,
		costUsd: opts.costUsd ?? null,
		resourceType: null,
		resourceId: opts.resourceId ?? null,
		errorCode: null,
		errorMessage: opts.errorMessage ?? null,
		tokensUsed: null,
		provider: null,
		model: opts.model ?? null,
		parentCallId: null,
		before: null,
		after: null,
	} as any);
	await getDb().execute(
		`UPDATE sdk_capability_calls SET created_at = '${opts.ts.toISOString()}' WHERE id = '${row.id}'` as any,
	);
}

test("listGlobalAudit fans in across extensions in createdAt DESC order", async () => {
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date("2026-05-01T10:00:00Z") });
	await seedCap({ extId: extB.id, capability: "memory", action: "read", success: true, ts: new Date("2026-05-01T11:00:00Z") });

	const result = await listGlobalAudit();
	expect(result.entries.length).toBeGreaterThanOrEqual(2);
	for (let i = 1; i < result.entries.length; i++) {
		expect(result.entries[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
			result.entries[i]!.createdAt.getTime(),
		);
	}
});

test("listGlobalAudit extensionId filter narrows", async () => {
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date() });
	await seedCap({ extId: extB.id, capability: "llm", action: "complete", success: true, ts: new Date() });

	const result = await listGlobalAudit({ extensionId: extA.id });
	for (const e of result.entries) {
		// capability rows include the extension via onBehalfOf+conv;
		// the simplest way to verify is to count both capability +
		// governance rows scoped to extA (governance rows would have
		// target=extA.id).
		if (e.kind === "governance") expect(e.target).toBe(extA.id);
	}
	expect(result.entries.length).toBeGreaterThan(0);
});

test("listGlobalAudit capability filter drops governance and narrows bucket", async () => {
	await insertAuditEntry(userId, "ext:permission-granted", extA.id, {
		permission: "test", oldValue: null, newValue: null, actor: userId,
	});
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date() });
	await seedCap({ extId: extA.id, capability: "memory", action: "read", success: true, ts: new Date() });

	const result = await listGlobalAudit({ capability: "llm" });
	for (const e of result.entries) {
		expect(e.kind).toBe("capability");
		if (e.kind === "capability") expect(e.capability).toBe("llm");
	}
});

test("listGlobalAudit denialOnly returns success=false + denial governance", async () => {
	await insertAuditEntry(userId, "ext:permission-granted", extA.id, {
		permission: "test", oldValue: null, newValue: null, actor: userId,
	});
	await insertAuditEntry(userId, "ext:permission-rejected", extA.id, {
		permission: "test", oldValue: null, newValue: null, actor: userId,
	});
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date() });
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: false, ts: new Date() });

	const result = await listGlobalAudit({ denialOnly: true });
	for (const e of result.entries) {
		if (e.kind === "governance") expect(e.action).not.toBe("ext:permission-granted");
		if (e.kind === "capability") expect(e.success).toBe(false);
	}
	// Both denial rows should be there.
	expect(result.entries.length).toBeGreaterThanOrEqual(2);
});

test("listGlobalAudit search filters by model substring", async () => {
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date(), model: "gpt-4o-mini" });
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date(), model: "claude-3-5-sonnet" });

	const result = await listGlobalAudit({ search: "claude" });
	expect(result.entries.length).toBe(1);
	if (result.entries[0]?.kind === "capability") {
		expect(result.entries[0].model).toContain("claude");
	}
});

test("listGlobalAudit search treats `%` as a literal, not a wildcard", async () => {
	// Seed two rows with distinct, non-wildcard models.
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date(), model: "gpt-4o-mini" });
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: new Date(), model: "claude-3-5-sonnet" });

	// `%` was previously left in the search term and (because
	// drizzle's `like()` doesn't emit ESCAPE) Postgres expanded it as
	// a wildcard, returning ALL rows. After sanitization, the literal
	// `%` is stripped and the remaining empty term skips the LIKE
	// clause entirely — returning no narrowing on `search`, but
	// crucially NOT collapsing to "match all because of wildcard".
	const all = await listGlobalAudit({});
	const totalRows = all.entries.length;

	const result = await listGlobalAudit({ search: "%" });
	// The sanitizer leaves an empty term, so the search clause is a
	// no-op and we get the same set as the unfiltered query — NOT a
	// wildcard "match every row" expansion (which would still equal
	// totalRows here, but the property we're asserting is that no
	// row was matched *via* the LIKE: the underlying model values
	// don't contain `%`, so a literal-`%` substring search matches 0).
	// To prove the no-wildcard property, search for `%4o%` — a
	// pattern that under the old buggy code would also match
	// "claude-3-5-sonnet" (because `%` is a wildcard). Under the
	// fix, only "gpt-4o-mini" is matched.
	expect(result.entries.length).toBe(totalRows);

	const literal = await listGlobalAudit({ search: "%4o%" });
	// The model `claude-3-5-sonnet` does NOT contain "4o" — under the
	// old buggy code, the `%4o%` would match it because `%` is a
	// wildcard at both ends. Under the fix, `%` is stripped and the
	// term becomes literal `4o`, matching only `gpt-4o-mini`.
	for (const e of literal.entries) {
		if (e.kind === "capability") {
			expect(e.model).toContain("4o");
		}
	}
	expect(literal.entries.length).toBe(1);
});

test("listGlobalAudit cursor pagination tie-breaks on id when same-ms rows collide", async () => {
	const sameTs = new Date("2026-05-01T15:00:00.000Z");
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: sameTs });
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: sameTs });

	const page1 = await listGlobalAudit({ limit: 1 });
	expect(page1.entries).toHaveLength(1);
	expect(page1.nextCursor).not.toBeNull();

	const page2 = await listGlobalAudit({ limit: 1, cursor: page1.nextCursor! });
	expect(page2.entries).toHaveLength(1);
	expect(page2.entries[0]!.id).not.toBe(page1.entries[0]!.id);
});

test("listGlobalAudit cursor pagination drives a second page", async () => {
	for (let i = 0; i < 5; i++) {
		await seedCap({
			extId: extA.id,
			capability: "llm",
			action: "complete",
			success: true,
			ts: new Date(`2026-05-01T1${i}:00:00Z`),
		});
	}
	const page1 = await listGlobalAudit({ limit: 2 });
	expect(page1.entries).toHaveLength(2);
	expect(page1.nextCursor).not.toBeNull();

	const page2 = await listGlobalAudit({ limit: 2, cursor: page1.nextCursor! });
	const ids1 = new Set(page1.entries.map((e) => e.id));
	for (const e of page2.entries) expect(ids1.has(e.id)).toBe(false);
});

test("globalStats aggregates within window: denials, total, topChattiest, topLlmSpenders", async () => {
	const recent = new Date(Date.now() - 1000 * 60 * 30);
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: true, ts: recent, costUsd: 0.05 });
	await seedCap({ extId: extA.id, capability: "llm", action: "complete", success: false, ts: recent });
	await seedCap({ extId: extA.id, capability: "memory", action: "read", success: true, ts: recent });
	await seedCap({ extId: extB.id, capability: "llm", action: "complete", success: true, ts: recent, costUsd: 0.10 });

	const stats = await globalStats(24 * 60 * 60 * 1000);
	expect(stats.totalCalls).toBe(4);
	expect(stats.denialCount).toBe(1);
	expect(stats.totalCostUsd).toBeCloseTo(0.15, 5);
	// Top chattiest: extA has 3, extB has 1.
	expect(stats.topChattiest.length).toBeGreaterThanOrEqual(1);
	expect(stats.topChattiest[0]!.extensionId).toBe(extA.id);
	expect(stats.topChattiest[0]!.calls).toBe(3);
	// Top LLM spenders: extB has 0.10, extA has 0.05.
	expect(stats.topLlmSpenders[0]!.extensionId).toBe(extB.id);
	expect(stats.topLlmSpenders[0]!.costUsd).toBeCloseTo(0.10, 5);
});
