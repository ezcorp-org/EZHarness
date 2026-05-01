/**
 * Server-handler unit tests for /api/modes/[id]/+server.ts.
 *
 * Covers scope/auth gates and the extensionIds round-trip paths.
 * `$server/db/queries/modes` is mocked at the module boundary so we
 * exercise the real handler + zod schema without touching PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/modes", () => ({
	getMode: vi.fn(),
	updateMode: vi.fn(),
	deleteMode: vi.fn(),
}));

const { getMode, updateMode, deleteMode } = await import(
	"$server/db/queries/modes"
);
const { GET, PUT, DELETE } = await import("../routes/api/modes/[id]/+server");

function makeEvent(opts: {
	id?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "m1";
	return {
		url: new URL(`http://localhost/api/modes/${id}`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/modes/${id}`, {
			method: opts.method ?? "GET",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		}),
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

const authedUser = {
	user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

function makeMode(overrides: Record<string, unknown> = {}) {
	return {
		id: "m1",
		name: "Debug",
		slug: "debug",
		icon: null,
		description: "",
		systemPromptInstruction: "Debug carefully.",
		instructionPosition: "prepend",
		preferredModel: null,
		preferredProvider: null,
		preferredThinkingLevel: null,
		temperature: null,
		toolRestriction: "all",
		extensionIds: null,
		builtin: false,
		userId: "u1",
		...overrides,
	};
}

describe("GET /api/modes/[id]", () => {
	beforeEach(() => {
		vi.mocked(getMode).mockReset();
		vi.mocked(updateMode).mockReset();
		vi.mocked(deleteMode).mockReset();
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(() => GET(makeEvent({ locals: {} })), 401);
	});

	test("returns 404 when mode does not exist", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(undefined as any);
		const res = await GET(makeEvent({ locals: authedUser }));
		expect(res.status).toBe(404);
	});

	test("happy path: returns mode JSON including extensionIds", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(
			makeMode({ id: "m1", extensionIds: ["ext-a", "ext-b"] }) as any,
		);
		const res = await GET(makeEvent({ locals: authedUser }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe("m1");
		expect(body.extensionIds).toEqual(["ext-a", "ext-b"]);
	});

	test("happy path: extensionIds=null is preserved on the wire (not stripped)", async () => {
		// Modes that haven't been edited under the new schema still have
		// extensionIds=null. The GET handler must surface the field as-is
		// so the client can distinguish "no extensions configured" from
		// "field unsupported on this server".
		vi.mocked(getMode).mockResolvedValueOnce(
			makeMode({ extensionIds: null }) as any,
		);
		const res = await GET(makeEvent({ locals: authedUser }));
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("extensionIds");
		expect(body.extensionIds).toBeNull();
	});
});

describe("PUT /api/modes/[id]", () => {
	beforeEach(() => {
		vi.mocked(getMode).mockReset();
		vi.mocked(updateMode).mockReset();
		vi.mocked(deleteMode).mockReset();
	});

	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await PUT(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["read"] },
				method: "PUT",
				body: {},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("chat");
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() => PUT(makeEvent({ locals: {}, method: "PUT", body: {} })),
			401,
		);
	});

	test("returns 404 when mode does not exist", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(undefined as any);
		const res = await PUT(
			makeEvent({ locals: authedUser, method: "PUT", body: {} }),
		);
		expect(res.status).toBe(404);
	});

	test("returns 403 when target mode is built-in", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(
			makeMode({ id: "builtin-plan", builtin: true, userId: null }) as any,
		);
		const res = await PUT(
			makeEvent({
				id: "builtin-plan",
				locals: authedUser,
				method: "PUT",
				body: {},
			}),
		);
		expect(res.status).toBe(403);
	});

	// ── extensionIds round-trip ──────────────────────────────────────

	test("happy path: PUT replaces extensionIds and returns updated mode", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(
			makeMode({ extensionIds: ["old-1"] }) as any,
		);
		vi.mocked(updateMode).mockImplementationOnce(
			async (_id: string, patch: any) =>
				makeMode({ extensionIds: patch.extensionIds }) as any,
		);

		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { extensionIds: ["new-a", "new-b"] },
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.extensionIds).toEqual(["new-a", "new-b"]);
		// Handler must pass the validated patch straight through.
		const [, passedPatch] = vi.mocked(updateMode).mock.calls[0]! as [
			string,
			any,
		];
		expect(passedPatch.extensionIds).toEqual(["new-a", "new-b"]);
	});

	test("happy path: PUT with extensionIds=[] clears the list", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(
			makeMode({ extensionIds: ["leftover"] }) as any,
		);
		vi.mocked(updateMode).mockImplementationOnce(
			async (_id: string, patch: any) =>
				makeMode({ extensionIds: patch.extensionIds }) as any,
		);

		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { extensionIds: [] },
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		// Empty array round-trips as an empty array (NOT null) so the
		// client sees that the user explicitly cleared the field.
		expect(body.extensionIds).toEqual([]);
		const [, passedPatch] = vi.mocked(updateMode).mock.calls[0]! as [
			string,
			any,
		];
		expect(passedPatch.extensionIds).toEqual([]);
	});

	test("returns 400 when PUT extensionIds has more than 100 entries", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(makeMode() as any);
		const tooMany = Array.from({ length: 101 }, (_, i) => `ext-${i}`);
		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { extensionIds: tooMany },
			}),
		);
		expect(res.status).toBe(400);
		expect(vi.mocked(updateMode)).not.toHaveBeenCalled();
	});

	test("returns 400 when PUT extensionIds contains non-string entries", async () => {
		vi.mocked(getMode).mockResolvedValueOnce(makeMode() as any);
		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { extensionIds: ["ok", null] },
			}),
		);
		expect(res.status).toBe(400);
		expect(vi.mocked(updateMode)).not.toHaveBeenCalled();
	});

	test("happy path: PUT without extensionIds leaves field untouched (partial update)", async () => {
		// updateModeSchema is .partial() — clients can update name without
		// having to resend the extension list.
		vi.mocked(getMode).mockResolvedValueOnce(
			makeMode({ extensionIds: ["keep-me"] }) as any,
		);
		vi.mocked(updateMode).mockImplementationOnce(
			async (_id: string, patch: any) =>
				makeMode({
					name: patch.name ?? "Debug",
					extensionIds: ["keep-me"],
				}) as any,
		);
		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { name: "Debug Renamed" },
			}),
		);
		expect(res.status).toBe(200);
		const [, passedPatch] = vi.mocked(updateMode).mock.calls[0]! as [
			string,
			any,
		];
		expect(passedPatch).not.toHaveProperty("extensionIds");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.extensionIds).toEqual(["keep-me"]);
	});
});

describe("DELETE /api/modes/[id]", () => {
	beforeEach(() => {
		vi.mocked(getMode).mockReset();
		vi.mocked(updateMode).mockReset();
		vi.mocked(deleteMode).mockReset();
	});

	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await DELETE(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["read"] },
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("chat");
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() => DELETE(makeEvent({ locals: {}, method: "DELETE" })),
			401,
		);
	});
});
