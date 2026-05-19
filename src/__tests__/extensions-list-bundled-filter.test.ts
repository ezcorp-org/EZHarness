/**
 * Phase 52.1 — `listExtensions({ bundled })` filter for the Library tabs.
 *
 * Asserts:
 *   - bundled=true returns only is_bundled=true rows
 *   - bundled=false returns only is_bundled=false rows
 *   - no opts → returns ALL rows (back-compat with the prior
 *     no-arg call sites in `bundled.ts`, `installer.ts`, etc.)
 *   - boolean signature still works (back-compat — `enabledOnly=true`
 *     filters by enabled column)
 *   - object form composes enabledOnly + bundled (defense for
 *     future call sites that need both)
 */
import { test, expect, beforeAll, afterAll, mock, afterEach } from "bun:test";
import {
	setupTestDb,
	closeTestDb,
	mockDbConnection,
} from "./helpers/test-pglite";

mockDbConnection();

const { createExtension, deleteExtension, listExtensions, updateExtension } = await import(
	"../db/queries/extensions"
);

beforeAll(async () => {
	await setupTestDb();
});

afterAll(async () => {
	await closeTestDb();
	mock.restore();
});

const createdIds: string[] = [];
afterEach(async () => {
	for (const id of createdIds.splice(0)) {
		await deleteExtension(id).catch(() => {});
	}
});

function makeInput(name: string, opts: { isBundled?: boolean; enabled?: boolean } = {}) {
	return {
		name,
		version: "1.0.0",
		description: "test",
		manifest: {
			schemaVersion: 2 as const,
			name,
			version: "1.0.0",
			description: "test",
			author: { name: "tester" },
			permissions: {},
		},
		source: "local:/tmp/x",
		installPath: "/tmp/x",
		enabled: opts.enabled ?? true,
		grantedPermissions: { grantedAt: {} } as any,
		checksumVerified: false,
		consecutiveFailures: 0,
		isBundled: opts.isBundled ?? false,
	} as any;
}

test("listExtensions({ bundled: true }) returns only bundled rows", async () => {
	const a = await createExtension(makeInput("phase52-bundled-a", { isBundled: true }));
	createdIds.push(a.id);
	const b = await createExtension(makeInput("phase52-bundled-b", { isBundled: false }));
	createdIds.push(b.id);

	const rows = await listExtensions({ bundled: true });
	const names = rows.map((r) => r.name);
	expect(names).toContain("phase52-bundled-a");
	expect(names).not.toContain("phase52-bundled-b");
});

test("listExtensions({ bundled: false }) returns only non-bundled rows", async () => {
	const a = await createExtension(makeInput("phase52-installed-a", { isBundled: false }));
	createdIds.push(a.id);
	const b = await createExtension(makeInput("phase52-installed-b", { isBundled: true }));
	createdIds.push(b.id);

	const rows = await listExtensions({ bundled: false });
	const names = rows.map((r) => r.name);
	expect(names).toContain("phase52-installed-a");
	expect(names).not.toContain("phase52-installed-b");
});

test("listExtensions() with no opts returns all rows (back-compat)", async () => {
	const a = await createExtension(makeInput("phase52-all-a", { isBundled: true }));
	createdIds.push(a.id);
	const b = await createExtension(makeInput("phase52-all-b", { isBundled: false }));
	createdIds.push(b.id);

	const rows = await listExtensions();
	const names = rows.map((r) => r.name);
	expect(names).toContain("phase52-all-a");
	expect(names).toContain("phase52-all-b");
});

test("listExtensions(true) — boolean form keeps enabledOnly back-compat", async () => {
	const enabled = await createExtension(
		makeInput("phase52-enabled", { enabled: true, isBundled: false }),
	);
	createdIds.push(enabled.id);
	const disabled = await createExtension(
		makeInput("phase52-disabled", { enabled: false, isBundled: false }),
	);
	createdIds.push(disabled.id);

	const rows = await listExtensions(true);
	const names = rows.map((r) => r.name);
	expect(names).toContain("phase52-enabled");
	expect(names).not.toContain("phase52-disabled");
});

test("listExtensions({ enabledOnly: true, bundled: false }) composes both filters", async () => {
	const installedEnabled = await createExtension(
		makeInput("phase52-comp-installed-enabled", { enabled: true, isBundled: false }),
	);
	createdIds.push(installedEnabled.id);
	const installedDisabled = await createExtension(
		makeInput("phase52-comp-installed-disabled", { enabled: false, isBundled: false }),
	);
	createdIds.push(installedDisabled.id);
	const bundledEnabled = await createExtension(
		makeInput("phase52-comp-bundled-enabled", { enabled: true, isBundled: true }),
	);
	createdIds.push(bundledEnabled.id);

	const rows = await listExtensions({ enabledOnly: true, bundled: false });
	const names = rows.map((r) => r.name);
	expect(names).toContain("phase52-comp-installed-enabled");
	expect(names).not.toContain("phase52-comp-installed-disabled");
	expect(names).not.toContain("phase52-comp-bundled-enabled");
});

// Suppress unused import warning — keeps the tooling happy.
void updateExtension;
