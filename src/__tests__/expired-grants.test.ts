/**
 * Phase 4 (capability-expiry) — `listExpiredGrantsForExtension`
 * end-to-end against a real PGlite instance.
 *
 * Pattern mirrors `perm-expiry-sweep.integration.test.ts` for db
 * mocking. Verifies the contract the settings-page banner consumes:
 *
 *   - Returns rows for action='ext:permission-grant-expired' AND
 *     target=<extensionId>.
 *   - Filters by lookback window (default 7 days; rows older than
 *     the window are excluded).
 *   - Skips rows with malformed metadata (missing capability or
 *     ageMs) — defensive contract guard.
 *   - Orders by createdAt DESC (newest first — matches "Recent
 *     permission expirations" framing).
 *   - Other-extension rows are not included.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
	closeTestDb,
	mockDbConnection,
	setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { auditLog } from "../db/schema";
import { getDb } from "../db/connection";
import { listExpiredGrantsForExtension } from "../db/queries/expired-grants";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
	await setupTestDb();
});

afterAll(async () => {
	restoreModuleMocks();
	await closeTestDb();
});

beforeEach(async () => {
	// Wipe rows so each test sees a fresh table.
	await getDb().delete(auditLog);
});

describe("listExpiredGrantsForExtension", () => {
	test("returns rows scoped to the extension within the default 7-day window", async () => {
		const now = Date.now();
		// Two recent rows for ext-a; one too-old; one for ext-b.
		await getDb().insert(auditLog).values([
			{
				id: "row-1",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: {
					capability: "shell",
					scope: "extensions-row",
					ttlMs: 30 * DAY_MS,
					ageMs: 35 * DAY_MS,
				},
				createdAt: new Date(now - 1 * DAY_MS),
			},
			{
				id: "row-2",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: {
					capability: "filesystem-write",
					scope: "extensions-row",
					ttlMs: 30 * DAY_MS,
					ageMs: 31 * DAY_MS,
				},
				createdAt: new Date(now - 6 * DAY_MS),
			},
			{
				id: "row-too-old",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: {
					capability: "network",
					scope: "extensions-row",
					ttlMs: 90 * DAY_MS,
					ageMs: 95 * DAY_MS,
				},
				createdAt: new Date(now - 10 * DAY_MS),
			},
			{
				id: "row-other-ext",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-b",
				metadata: {
					capability: "shell",
					scope: "extensions-row",
					ttlMs: 30 * DAY_MS,
					ageMs: 31 * DAY_MS,
				},
				createdAt: new Date(now - 1 * DAY_MS),
			},
		]);

		const out = await listExpiredGrantsForExtension("ext-a", { now });
		expect(out).toHaveLength(2);
		// DESC-ordered — row-1 (1d ago) first, row-2 (6d ago) second.
		expect(out[0]?.auditId).toBe("row-1");
		expect(out[0]?.capability).toBe("shell");
		expect(out[1]?.auditId).toBe("row-2");
		expect(out[1]?.capability).toBe("filesystem-write");
		// Other-extension and too-old rows excluded.
		expect(out.find((r) => r.auditId === "row-too-old")).toBeUndefined();
		expect(out.find((r) => r.auditId === "row-other-ext")).toBeUndefined();
	});

	test("skips rows with malformed metadata (missing capability or ageMs)", async () => {
		const now = Date.now();
		await getDb().insert(auditLog).values([
			{
				id: "row-good",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: {
					capability: "shell",
					scope: "extensions-row",
					ttlMs: 30 * DAY_MS,
					ageMs: 35 * DAY_MS,
				},
				createdAt: new Date(now - 1 * DAY_MS),
			},
			{
				id: "row-no-cap",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: { ageMs: 35 * DAY_MS },
				createdAt: new Date(now - 1 * DAY_MS),
			},
			{
				id: "row-bad-age",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: { capability: "shell", ageMs: "not-a-number" },
				createdAt: new Date(now - 1 * DAY_MS),
			},
			{
				id: "row-null-meta",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: null,
				createdAt: new Date(now - 1 * DAY_MS),
			},
		]);

		const out = await listExpiredGrantsForExtension("ext-a", { now });
		expect(out).toHaveLength(1);
		expect(out[0]?.auditId).toBe("row-good");
	});

	test("returns empty list when no rows match", async () => {
		const out = await listExpiredGrantsForExtension("ext-empty", {
			now: Date.now(),
		});
		expect(out).toEqual([]);
	});

	test("respects a custom lookbackMs window", async () => {
		const now = Date.now();
		await getDb().insert(auditLog).values([
			{
				id: "row-2d",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: { capability: "shell", ageMs: 30 * DAY_MS },
				createdAt: new Date(now - 2 * DAY_MS),
			},
			{
				id: "row-30d",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
				target: "ext-a",
				metadata: { capability: "network", ageMs: 100 * DAY_MS },
				createdAt: new Date(now - 30 * DAY_MS),
			},
		]);
		// 1d window — only row-2d row excluded; both rows older than 1d
		// are excluded.
		const oneDayWindow = await listExpiredGrantsForExtension("ext-a", {
			now,
			lookbackMs: 1 * DAY_MS,
		});
		expect(oneDayWindow).toEqual([]);
		// 60d window — both rows in range.
		const wide = await listExpiredGrantsForExtension("ext-a", {
			now,
			lookbackMs: 60 * DAY_MS,
		});
		expect(wide).toHaveLength(2);
	});

	test("does NOT match rows with a different action (only PERM_GRANT_EXPIRED)", async () => {
		const now = Date.now();
		await getDb().insert(auditLog).values([
			{
				id: "row-not-expired",
				userId: null,
				action: EXT_AUDIT_ACTIONS.PERMISSION_GRANTED,
				target: "ext-a",
				metadata: { capability: "shell", ageMs: 30 * DAY_MS },
				createdAt: new Date(now - 1 * DAY_MS),
			},
			{
				id: "row-also-not",
				userId: null,
				action: "extension:permissions_granted",
				target: "ext-a",
				metadata: { capability: "shell", ageMs: 30 * DAY_MS },
				createdAt: new Date(now - 1 * DAY_MS),
			},
		]);
		const out = await listExpiredGrantsForExtension("ext-a", { now });
		expect(out).toEqual([]);
	});
});
