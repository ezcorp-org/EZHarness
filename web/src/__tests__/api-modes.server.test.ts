/**
 * Server-handler unit tests for /api/modes/+server.ts.
 *
 * Covers scope/auth gates and the zod validation gate on POST. Success
 * paths mock `$server/db/queries/modes` at the module boundary so we
 * exercise the real handler + zod schema without touching PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/modes", () => ({
	listModes: vi.fn(),
	createMode: vi.fn(),
}));

const { listModes, createMode } = await import("$server/db/queries/modes");
const { GET, POST } = await import("../routes/api/modes/+server");

function makeGetEvent(opts: { locals?: Record<string, unknown> }) {
	return {
		url: new URL("http://localhost/api/modes"),
		locals: opts.locals ?? {},
		request: new Request("http://localhost/api/modes", { method: "GET" }),
	} as any;
}

function makePostEvent(opts: {
	body?: unknown;
	locals?: Record<string, unknown>;
}) {
	return {
		url: new URL("http://localhost/api/modes"),
		locals: opts.locals ?? {},
		request: new Request("http://localhost/api/modes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
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

const baseModeBody = {
	name: "Debug",
	slug: "debug",
	systemPromptInstruction: "Debug carefully.",
};

function makeMode(overrides: Record<string, unknown> = {}) {
	return {
		id: "mode-new",
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

describe("GET /api/modes", () => {
	beforeEach(() => {
		vi.mocked(listModes).mockReset();
		vi.mocked(createMode).mockReset();
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeGetEvent({
				locals: { ...authedUser, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(() => GET(makeGetEvent({})), 401);
	});

	test("happy path: returns modes including extensionIds field round-trip", async () => {
		// Verifies GET surfaces extensionIds as the queries layer returns it —
		// guards against an accidental field strip in the handler.
		vi.mocked(listModes).mockResolvedValueOnce([
			makeMode({ id: "m1", extensionIds: ["ext-a", "ext-b"] }) as any,
			makeMode({ id: "m2", extensionIds: null }) as any,
		]);
		const res = await GET(makeGetEvent({ locals: authedUser }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(2);
		expect(body[0]!.extensionIds).toEqual(["ext-a", "ext-b"]);
		expect(body[1]!.extensionIds).toBeNull();
	});
});

describe("POST /api/modes", () => {
	beforeEach(() => {
		vi.mocked(listModes).mockReset();
		vi.mocked(createMode).mockReset();
	});

	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await POST(
			makePostEvent({
				locals: { ...authedUser, apiKeyScopes: ["read"] },
				body: {},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.required).toBe("chat");
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() => POST(makePostEvent({ body: {} })),
			401,
		);
	});

	test("returns 400 on empty body (missing required fields)", async () => {
		const res = await POST(makePostEvent({ locals: authedUser, body: {} }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Validation failed");
	});

	test("returns 400 when slug has invalid characters", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: {
					name: "Debug",
					slug: "NOT_ok",
					systemPromptInstruction: "think hard",
				},
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Validation failed");
	});

	test("returns 400 when systemPromptInstruction is empty", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: {
					name: "Debug",
					slug: "debug",
					systemPromptInstruction: "",
				},
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Validation failed");
	});

	// ── extensionIds round-trip ──────────────────────────────────────

	test("happy path: POST with extensionIds=['x','y'] returns 201 and persists list", async () => {
		// The handler should pass the validated extensionIds straight through
		// to createMode and surface them on the response body.
		vi.mocked(createMode).mockImplementationOnce(async (input: any) =>
			makeMode({
				id: "mode-fresh",
				name: input.name,
				slug: input.slug,
				systemPromptInstruction: input.systemPromptInstruction,
				extensionIds: input.extensionIds ?? null,
			}) as any,
		);

		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { ...baseModeBody, extensionIds: ["x", "y"] },
			}),
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe("mode-fresh");
		expect(body.extensionIds).toEqual(["x", "y"]);
		// Verify the handler called createMode with the validated payload —
		// proves zod didn't strip the field and userId is forwarded.
		expect(vi.mocked(createMode)).toHaveBeenCalledTimes(1);
		const passedArg = vi.mocked(createMode).mock.calls[0]![0]! as any;
		expect(passedArg.extensionIds).toEqual(["x", "y"]);
		expect(passedArg.userId).toBe("u1");
	});

	test("happy path: POST without extensionIds field (back-compat) returns 201", async () => {
		// Schema marks extensionIds as optional — omitting it must not
		// reject the create flow.
		vi.mocked(createMode).mockResolvedValueOnce(makeMode() as any);
		const res = await POST(
			makePostEvent({ locals: authedUser, body: baseModeBody }),
		);
		expect(res.status).toBe(201);
		const passedArg = vi.mocked(createMode).mock.calls[0]![0]! as any;
		expect(passedArg.extensionIds).toBeUndefined();
	});

	test("returns 400 when extensionIds has more than 100 entries", async () => {
		const tooMany = Array.from({ length: 101 }, (_, i) => `ext-${i}`);
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { ...baseModeBody, extensionIds: tooMany },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Validation failed");
		// createMode must never be reached when zod rejects the body.
		expect(vi.mocked(createMode)).not.toHaveBeenCalled();
	});

	test("returns 400 when extensionIds contains non-string entries", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { ...baseModeBody, extensionIds: ["ok", 42, true] },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Validation failed");
		expect(vi.mocked(createMode)).not.toHaveBeenCalled();
	});

	test("returns 400 when an extensionIds entry exceeds 200 chars (per-entry guard)", async () => {
		const huge = "x".repeat(201);
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { ...baseModeBody, extensionIds: ["ok", huge] },
			}),
		);
		expect(res.status).toBe(400);
		expect(vi.mocked(createMode)).not.toHaveBeenCalled();
	});

	test("happy path: empty extensionIds array passes validation and forwards []", async () => {
		// `[]` is the documented "clear all attached extensions" payload.
		vi.mocked(createMode).mockImplementationOnce(async (input: any) =>
			makeMode({ extensionIds: input.extensionIds ?? null }) as any,
		);
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { ...baseModeBody, extensionIds: [] },
			}),
		);
		expect(res.status).toBe(201);
		const passedArg = vi.mocked(createMode).mock.calls[0]![0]! as any;
		expect(passedArg.extensionIds).toEqual([]);
	});
});
