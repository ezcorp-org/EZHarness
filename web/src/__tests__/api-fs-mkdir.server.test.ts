/**
 * Server-handler unit tests for /api/fs/mkdir/+server.ts.
 * Auth gate — success path actually mkdir's; we test only the auth/validation.
 * node:fs/promises is mocked so the sandbox checks run deterministically.
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";

const realpath = vi.fn();
const mkdir = vi.fn(async () => undefined);
vi.mock("node:fs/promises", () => ({
	realpath,
	mkdir,
	default: { realpath, mkdir },
}));

const { POST } = await import("../routes/api/fs/mkdir/+server");

function makeEvent(opts: { body?: unknown; locals?: Record<string, unknown> }) {
	return {
		url: new URL("http://localhost/api/fs/mkdir"),
		locals: opts.locals ?? {},
		request: new Request("http://localhost/api/fs/mkdir", {
			method: "POST",
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
	try { res = await fn(); }
	catch (thrown) { expect(thrown).toBeInstanceOf(Response); res = thrown as Response; }
	expect(res!.status).toBe(status);
	return res!;
}

const adminLocals = {
	user: { id: "a1", email: "a@x", name: "A", role: "admin" },
};
const memberLocals = {
	user: { id: "u1", email: "u@x", name: "U", role: "user" },
};

describe("POST /api/fs/mkdir", () => {
	const originalRoot = process.env.EZCORP_PROJECT_ROOT;

	beforeEach(() => {
		realpath.mockReset();
		mkdir.mockReset();
		mkdir.mockResolvedValue(undefined);
		process.env.EZCORP_PROJECT_ROOT = "/tmp/ezcorp-test-sandbox";
	});

	afterEach(() => {
		if (originalRoot === undefined) delete process.env.EZCORP_PROJECT_ROOT;
		else process.env.EZCORP_PROJECT_ROOT = originalRoot;
	});

	test("rejects 401 when no auth", async () => {
		await expectThrownResponse(
			() => POST(makeEvent({ body: { path: "/tmp/x" } })),
			401,
		);
	});

	test("returns 403 when caller is not admin", async () => {
		const res = await POST(
			makeEvent({ body: { path: "/tmp/x" }, locals: memberLocals }),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("admin role required");
	});

	test("rejects 403 when API-key lacks 'read' scope", async () => {
		const res = await POST(
			makeEvent({
				body: { path: "/tmp/x" },
				locals: { ...adminLocals, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
	});

	test("rejects 400 when path is missing", async () => {
		const res = await POST(makeEvent({ body: {}, locals: adminLocals }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("path required");
	});

	test("rejects 400 when path is blank whitespace", async () => {
		const res = await POST(
			makeEvent({ body: { path: "   " }, locals: adminLocals }),
		);
		expect(res.status).toBe(400);
	});

	test("returns 500 when sandbox root realpath fails", async () => {
		realpath.mockRejectedValueOnce(new Error("boom"));
		const res = await POST(
			makeEvent({
				body: { path: "/tmp/ezcorp-test-sandbox/new" },
				locals: adminLocals,
			}),
		);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Sandbox root unavailable");
	});

	test("returns 403 when resolved ancestor is outside sandbox", async () => {
		// Sandbox root resolves cleanly; all ancestor lookups land on /etc.
		realpath.mockImplementationOnce(async () => "/tmp/ezcorp-test-sandbox");
		realpath.mockImplementation(async () => "/etc");
		const res = await POST(
			makeEvent({
				body: { path: "/etc/evil" },
				locals: adminLocals,
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("path outside allowed sandbox");
	});

	test("returns 201 with created path on success", async () => {
		realpath.mockImplementation(async () => "/tmp/ezcorp-test-sandbox");
		const res = await POST(
			makeEvent({
				body: { path: "/tmp/ezcorp-test-sandbox/nested/new" },
				locals: adminLocals,
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { path?: string };
		expect(body.path).toBe("/tmp/ezcorp-test-sandbox/nested/new");
		expect(mkdir).toHaveBeenCalledWith(
			"/tmp/ezcorp-test-sandbox/nested/new",
			{ recursive: true },
		);
	});
});
