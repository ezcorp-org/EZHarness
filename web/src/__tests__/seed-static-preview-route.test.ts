/** Direct PGlite contracts for the authenticated static-preview test fixture. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { closeTestDb, mockDbConnection, mockRealSettings, setupTestDb } from "../../../src/__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();

const { POST, DELETE } = await import("../routes/api/__test/seed-static-preview/+server");
const { getPreviewByIdRaw, previewSitesRoot } = await import("../../../src/db/queries/preview-sessions");
const { createUser } = await import("../../../src/db/queries/users");

const root = mkdtempSync(join(tmpdir(), "ezh-static-preview-route-"));
const savedE2E = process.env.PI_E2E_REAL;
const savedNodeEnv = process.env.NODE_ENV;
const savedAllow = process.env.EZCORP_ALLOW_TEST_SURFACE;
const savedProjectRoot = process.env.EZCORP_PROJECT_ROOT;
const owner = { id: "preview-owner", email: "owner@example.test", name: "Owner", role: "member" } as const;
const other = { id: "preview-other", email: "other@example.test", name: "Other", role: "member" } as const;

function event(request: Request, user: typeof owner | typeof other | null = owner): Parameters<typeof POST>[0] {
	return { request, locals: user ? { user } : {} } as Parameters<typeof POST>[0];
}

function deleteRequest(body: unknown): Request {
	return new Request("http://localhost/api/__test/seed-static-preview", {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function expectUnauthorized(call: () => Promise<Response>): Promise<void> {
	let denial: unknown;
	try {
		await call();
	} catch (error) {
		denial = error;
	}
	expect(denial).toBeInstanceOf(Response);
	const response = denial as Response;
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: "Authentication required" });
}

beforeAll(async () => {
	await setupTestDb();
	await createUser({ ...owner, passwordHash: "unused", status: "active" });
	await createUser({ ...other, passwordHash: "unused", status: "active" });
});
afterAll(async () => {
	await closeTestDb();
	restoreModuleMocks();
	rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
	process.env.PI_E2E_REAL = "1";
	delete process.env.NODE_ENV;
	process.env.EZCORP_ALLOW_TEST_SURFACE = "1";
	process.env.EZCORP_PROJECT_ROOT = root;
});
afterEach(() => {
	if (savedE2E === undefined) delete process.env.PI_E2E_REAL; else process.env.PI_E2E_REAL = savedE2E;
	if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
	if (savedAllow === undefined) delete process.env.EZCORP_ALLOW_TEST_SURFACE; else process.env.EZCORP_ALLOW_TEST_SURFACE = savedAllow;
	if (savedProjectRoot === undefined) delete process.env.EZCORP_PROJECT_ROOT; else process.env.EZCORP_PROJECT_ROOT = savedProjectRoot;
});

describe("/api/__test/seed-static-preview", () => {
	test("fails closed when the test surface is disabled", async () => {
		delete process.env.PI_E2E_REAL;
		expect((await POST(event(new Request("http://localhost")))).status).toBe(404);
		expect((await DELETE(event(deleteRequest({ previewId: "anything" })))).status).toBe(404);
	});

	test("requires an authenticated owner for both create and cleanup", async () => {
		await expectUnauthorized(() => POST(event(new Request("http://localhost"), null)));
		await expectUnauthorized(() => DELETE(event(deleteRequest({ previewId: "anything" }), null)));
	});

	test("creates an owner-bound preview row, static content, and handoff code", async () => {
		const response = await POST(event(new Request("http://localhost")));
		expect(response.status).toBe(200);
		const { previewId, code } = await response.json() as { previewId: string; code: string };
		expect(previewId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(code.length).toBeGreaterThan(20);

		const preview = await getPreviewByIdRaw(previewId);
		expect(preview).toMatchObject({ id: previewId, userId: owner.id, kind: "static", status: "active" });
		expect(preview?.staticPath?.startsWith(`${previewSitesRoot()}${sep}`)).toBe(true);
		expect(readFileSync(join(preview!.staticPath!, "index.html"), "utf8")).toContain("E2E static preview");
	});

	test("does not reveal or delete a different owner's preview", async () => {
		const seeded = await POST(event(new Request("http://localhost")));
		const { previewId } = await seeded.json() as { previewId: string };
		const preview = await getPreviewByIdRaw(previewId);
		const staticPath = preview!.staticPath!;

		const foreign = await DELETE(event(deleteRequest({ previewId }), other));
		expect(foreign.status).toBe(404);
		expect((await getPreviewByIdRaw(previewId))?.status).toBe("active");
		expect(existsSync(staticPath)).toBe(true);

		await DELETE(event(deleteRequest({ previewId })));
	});

	test("validates cleanup payload then revokes the owner row and removes its jailed tree", async () => {
		const seeded = await POST(event(new Request("http://localhost")));
		const { previewId } = await seeded.json() as { previewId: string };
		const staticPath = (await getPreviewByIdRaw(previewId))!.staticPath!;

		expect((await DELETE(event(deleteRequest({})))).status).toBe(400);
		expect((await DELETE(event(new Request("http://localhost", { method: "DELETE", body: "{not json" })))).status).toBe(400);

		const cleanup = await DELETE(event(deleteRequest({ previewId })));
		expect(await cleanup.json()).toEqual({ ok: true });
		expect((await getPreviewByIdRaw(previewId))?.status).toBe("revoked");
		expect(existsSync(staticPath)).toBe(false);
	});
});
