/**
 * Server-handler unit tests for /api/conversations/[id]/messages/[mid]/+server.ts.
 * Auth gate — success path mutates DB.
 */

import { describe, expect, test } from "vitest";
import { PATCH } from "../routes/api/conversations/[id]/messages/[mid]/+server";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

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
	expect(res).toBeInstanceOf(Response);
	expect(res!.status).toBe(status);
	return res!;
}


function makeEvent(opts: { body?: unknown; locals?: Record<string, unknown> }) {
	return makeRequestEvent("http://localhost/api/conversations/c1/messages/m1", {
	  locals: opts.locals ?? {},
	  params: { id: "c1", mid: "m1" },
	  request: {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		},
	});
}

describe("PATCH /api/conversations/[id]/messages/[mid]", () => {
	test("rejects 401 when no auth", async () => {
		await expectThrownResponse(
			() => PATCH(makeEvent({ body: { content: "edited" } })),
			401,
		);
	});
});
