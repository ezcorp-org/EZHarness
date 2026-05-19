/**
 * Server-handler unit tests for /api/conversations/[id]/messages/[mid]/+server.ts.
 * Auth gate — success path mutates DB.
 */

import { test, expect, describe } from "vitest";
import { PATCH } from "../routes/api/conversations/[id]/messages/[mid]/+server";

function makeEvent(opts: { body?: unknown; locals?: Record<string, unknown> }) {
	return {
		url: new URL("http://localhost/api/conversations/c1/messages/m1"),
		locals: opts.locals ?? {},
		params: { id: "c1", mid: "m1" },
		request: new Request("http://localhost/api/conversations/c1/messages/m1", {
			method: "PATCH",
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

describe("PATCH /api/conversations/[id]/messages/[mid]", () => {
	test("rejects 401 when no auth", async () => {
		await expectThrownResponse(
			() => PATCH(makeEvent({ body: { content: "edited" } })),
			401,
		);
	});
});
