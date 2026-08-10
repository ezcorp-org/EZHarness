/**
 * Server-handler unit tests for /api/projects/+server.ts.
 * Auth gate + POST validation gate. Success branches hit the DB.
 */

import { test, expect, describe } from "vitest";
import { GET, POST } from "../routes/api/projects/+server";
import { expectThrownResponse } from "./helpers/server-route-test-utils";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

function makeGetEvent(locals: Record<string, unknown> = {}) {
	return makeRequestEvent("http://localhost/api/projects", {
	  locals,
	  request: null,
	});
}

function makePostEvent(body: unknown, locals: Record<string, unknown> = {}) {
	return makeRequestEvent("http://localhost/api/projects", {
	  locals,
	  request: {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	});
}

describe("GET /api/projects", () => {
	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeGetEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const user = { id: "u1", email: "u@x", name: "u", role: "user" };
		const res = await GET(makeGetEvent({ user, apiKeyScopes: ["chat"] }));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
	});
});

describe("POST /api/projects", () => {
	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(
			() => POST(makePostEvent({ name: "x", path: "/x" }, {})),
			401,
		);
		expect(res.status).toBe(401);
	});

	test("returns 403 when API-key scope missing 'write'", async () => {
		const user = { id: "u1", email: "u@x", name: "u", role: "user" };
		const res = await POST(
			makePostEvent(
				{ name: "x", path: "/x" },
				{ user, apiKeyScopes: ["chat"] },
			),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("write");
	});

	test("a read-only key can no longer create a project", async () => {
		// The whole point of the 2026-08 re-scope: `read` used to create
		// projects. GET below still takes `read` — the split is per-verb.
		const user = { id: "u1", email: "u@x", name: "u", role: "user" };
		const res = await POST(
			makePostEvent({ name: "x", path: "/x" }, { user, apiKeyScopes: ["read"] }),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { required?: string }).required).toBe("write");
	});

	test("rejects 400 when name or path missing (auth'd user)", async () => {
		const user = { id: "u1", email: "u@test.com", name: "U", role: "member" };
		// Both empty -> 400 path. Don't pass body that triggers DB on success.
		const res = await POST(makePostEvent({ name: "", path: "" }, { user }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("required");
	});

	/**
	 * Path SHAPE, which the route accepted unconditionally until now
	 * (`path: z.string()` plus an emptiness check). Both inputs below are
	 * transcriptions of corruptions that actually reached the database on
	 * this instance, and neither failed at the time — the project saved, the
	 * folder appeared, chats worked, and the files were on the container's
	 * throwaway overlay or nowhere at all.
	 */
	describe("path shape", () => {
		const user = { id: "u1", email: "u@test.com", name: "U", role: "member" };

		test("rejects the tilde path as TYPED — it is not absolute", async () => {
			// What a user actually enters. The leading `~` means it fails the
			// absolute rule first, which is the correct and clearest message.
			const res = await POST(
				makePostEvent({ name: "herdr", path: "~/projects/herdr" }, { user }),
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error?: string }).error).toContain("absolute");
		});

		test("rejects the tilde path as RESOLVED — a literal ~ directory", async () => {
			// `/app/web/~/projects/<name>` is the form that reached the disk:
			// `resolve()` rooted the typed string at the server cwd. It IS
			// absolute, so only the tilde-segment rule stands between this and
			// 270 MB on the container's throwaway overlay.
			const res = await POST(
				makePostEvent({ name: "herdr", path: "/app/web/~/projects/herdr" }, { user }),
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error?: string }).error).toContain("~");
		});

		test("rejects a relative path — resolve() would root it at the server cwd", async () => {
			const res = await POST(
				makePostEvent({ name: "ezAppTest", path: "app/ezAppTest" }, { user }),
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error?: string }).error).toContain("absolute");
		});

		test("rejects a .. segment", async () => {
			const res = await POST(
				makePostEvent({ name: "esc", path: "/app/web/../../etc" }, { user }),
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error?: string }).error).toContain("..");
		});

		test("a tilde INSIDE a segment is fine — only a bare ~ segment is the bug", async () => {
			// `/app/web/.ezcorp/projects/my~project` is a legal directory name.
			// Rejecting every string containing "~" would be a stricter rule
			// than the failure justifies, so the guard splits on "/" first.
			// 403 (not 400) proves it cleared validation: this key lacks write.
			const res = await POST(
				makePostEvent(
					{ name: "tilde-in-name", path: "/app/web/.ezcorp/projects/my~project" },
					{ user, apiKeyScopes: ["read"] },
				),
			);
			expect(res.status).toBe(403);
		});
	});
});
