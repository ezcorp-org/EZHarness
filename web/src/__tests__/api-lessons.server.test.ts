/**
 * Vitest server-handler tests for /api/lessons/+server.ts (the list
 * endpoint that drives the Lessons curation tab).
 *
 * Pattern mirrors `api-mentions-search-lesson.server.test.ts`: the
 * `$server/db/queries/lessons` module is mocked at the top of the file
 * BEFORE the handler is imported, so we never touch a real DB and can
 * cleanly assert request-shape (projectId, user.id) → response-shape
 * (no internal-field leakage, ownedByMe flag wired correctly).
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const mockListVisibleLessons = vi.fn();
vi.mock("$server/db/queries/lessons", () => ({
	listVisibleLessons: mockListVisibleLessons,
}));

const { GET } = await import("../routes/api/lessons/+server");

function makeEvent(opts: { href: string; locals?: Record<string, unknown> }) {
	return {
		url: new URL(opts.href),
		locals: opts.locals ?? {},
		request: new Request(opts.href, { method: "GET" }),
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		res = await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res!.status).toBe(status);
	return res!;
}

const USER = { id: "u1", email: "u@x", name: "u", role: "user" };
const OTHER = { id: "u2", email: "o@x", name: "o", role: "user" };

function lessonRow(overrides: Partial<{
	id: string;
	slug: string;
	title: string;
	body: string;
	visibility: "user" | "project" | "global";
	ownerId: string;
	projectId: string;
	source: "user" | "distiller";
	sourceSha256: string | null;
	frontmatter: Record<string, unknown> | null;
	firedCount: number;
	lastFiredAt: Date | null;
	dismissedCount: number;
}> = {}) {
	return {
		id: "lid-1",
		projectId: "p1",
		ownerId: "u1",
		visibility: "user" as const,
		slug: "rule-a",
		title: "Rule A",
		body: "Body of rule A.",
		frontmatter: null,
		source: "distiller" as const,
		sourceSha256: "deadbeef",
		firedCount: 3,
		lastFiredAt: new Date("2026-04-01T00:00:00Z"),
		dismissedCount: 0,
		createdAt: new Date("2026-03-01T00:00:00Z"),
		updatedAt: new Date("2026-03-15T00:00:00Z"),
		...overrides,
	};
}

describe("GET /api/lessons", () => {
	beforeEach(() => {
		mockListVisibleLessons.mockReset();
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
		expect(mockListVisibleLessons).not.toHaveBeenCalled();
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent({ href: "http://localhost/api/lessons", locals: {} })),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("returns 400 when projectId query param is missing", async () => {
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons",
				locals: { user: USER },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("projectId");
		// MUST NOT have hit the DB.
		expect(mockListVisibleLessons).not.toHaveBeenCalled();
	});

	test("calls listVisibleLessons with (projectId, user.id) — visibility scoping wired through user.id", async () => {
		mockListVisibleLessons.mockResolvedValue([]);
		await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER },
			}),
		);
		expect(mockListVisibleLessons).toHaveBeenCalledTimes(1);
		const args = mockListVisibleLessons.mock.calls[0]!;
		expect(args[0]).toBe("p1");
		expect(args[1]).toBe("u1");
	});

	test("returns empty array when no lessons exist", async () => {
		mockListVisibleLessons.mockResolvedValue([]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER },
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("response shape: every entry has the curation contract — id, slug, title, body, visibility, ownedByMe, counters, timestamps, frontmatter", async () => {
		mockListVisibleLessons.mockResolvedValue([lessonRow()]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		const row = body[0]!;
		expect(row).toHaveProperty("id", "lid-1");
		expect(row).toHaveProperty("slug", "rule-a");
		expect(row).toHaveProperty("title", "Rule A");
		expect(row).toHaveProperty("body", "Body of rule A.");
		expect(row).toHaveProperty("visibility", "user");
		expect(row).toHaveProperty("ownedByMe", true);
		expect(row).toHaveProperty("source", "distiller");
		expect(row).toHaveProperty("firedCount", 3);
		expect(row).toHaveProperty("lastFiredAt");
		expect(row).toHaveProperty("dismissedCount", 0);
		expect(row).toHaveProperty("createdAt");
		expect(row).toHaveProperty("updatedAt");
		expect(row).toHaveProperty("frontmatter", null);
	});

	test("ownedByMe: true for rows owned by the requesting user (any visibility)", async () => {
		mockListVisibleLessons.mockResolvedValue([
			lessonRow({ id: "u-row", visibility: "user", ownerId: USER.id }),
			lessonRow({ id: "p-row", visibility: "project", ownerId: USER.id }),
			lessonRow({ id: "g-row", visibility: "global", ownerId: USER.id }),
		]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER },
			}),
		);
		const body = (await res.json()) as Array<{ id: string; ownedByMe: boolean }>;
		expect(body.find((r) => r.id === "u-row")!.ownedByMe).toBe(true);
		expect(body.find((r) => r.id === "p-row")!.ownedByMe).toBe(true);
		expect(body.find((r) => r.id === "g-row")!.ownedByMe).toBe(true);
	});

	test("ownedByMe: false for project-scoped rows owned by another user — UI uses this to gate delete + promote", async () => {
		mockListVisibleLessons.mockResolvedValue([
			lessonRow({ id: "shared", visibility: "project", ownerId: OTHER.id }),
		]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER },
			}),
		);
		const body = (await res.json()) as Array<{ ownedByMe: boolean }>;
		expect(body[0]!.ownedByMe).toBe(false);
	});

	test("internal DB fields do NOT leak (ownerId, projectId, sourceSha256)", async () => {
		// Headline guarantee: the curation API must not surface
		// `ownerId` (user-id enumeration vector), `projectId` (already
		// known to the caller), or `sourceSha256` (internal distiller
		// dedupe key — leaking it could expose conversation snippets).
		mockListVisibleLessons.mockResolvedValue([
			lessonRow({ ownerId: OTHER.id, sourceSha256: "secret-hash" }),
		]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER },
			}),
		);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body[0]).not.toHaveProperty("ownerId");
		expect(body[0]).not.toHaveProperty("projectId");
		expect(body[0]).not.toHaveProperty("sourceSha256");
	});

	test("preserves ordering returned by listVisibleLessons (visibility-priority dedup is the query layer's job)", async () => {
		mockListVisibleLessons.mockResolvedValue([
			lessonRow({ id: "1", slug: "a" }),
			lessonRow({ id: "2", slug: "b" }),
			lessonRow({ id: "3", slug: "c" }),
		]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/lessons?projectId=p1",
				locals: { user: USER },
			}),
		);
		const body = (await res.json()) as Array<{ slug: string }>;
		expect(body.map((r) => r.slug)).toEqual(["a", "b", "c"]);
	});
});
