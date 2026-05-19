/**
 * Server-handler unit tests for
 * /api/projects/[id]/tool-permission-mode/+server.ts.
 *
 * The handler defers to the shared tool-permission helper via dynamic import;
 * we cover only the upstream scope gate that runs before that import.
 * (No requireAuth gate on this handler — scope-only.)
 */

import { test, expect, describe } from "vitest";
import { GET, PUT } from "../routes/api/projects/[id]/tool-permission-mode/+server";

function makeEvent(opts: {
	id?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "p1";
	return {
		url: new URL(`http://localhost/api/projects/${id}/tool-permission-mode`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(
			`http://localhost/api/projects/${id}/tool-permission-mode`,
			{
				method: opts.method ?? "GET",
				headers: { "content-type": "application/json" },
				body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			},
		),
	} as any;
}

describe("GET /api/projects/[id]/tool-permission-mode", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: {
					user: { id: "u1", email: "u@x", name: "u", role: "user" },
					apiKeyScopes: ["chat"],
				},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
	});
});

describe("PUT /api/projects/[id]/tool-permission-mode", () => {
	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await PUT(
			makeEvent({
				locals: {
					user: { id: "u1", email: "u@x", name: "u", role: "user" },
					apiKeyScopes: ["read"],
				},
				method: "PUT",
				body: { mode: "ask" },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("chat");
	});
});
