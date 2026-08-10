/**
 * Server-handler unit tests for /api/conversations/[id]/messages/[mid]/+server.ts.
 * Auth gate — success path mutates DB.
 */

import { test, expect, describe } from "vitest";
import { PATCH } from "../routes/api/conversations/[id]/messages/[mid]/+server";
import { expectThrownResponse } from "./helpers/server-route-test-utils";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

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
