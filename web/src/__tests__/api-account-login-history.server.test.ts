/**
 * Server-handler unit test for /api/account/login-history/+server.ts.
 * Auth gate only — success path lists audit-log rows from the DB.
 */

import { test, expect, describe } from "vitest";
import { GET } from "../routes/api/account/login-history/+server";
import { expectThrownResponse, makeRequestEvent } from "./helpers/server-route-test-utils";

function makeEvent(locals: Record<string, unknown> = {}) {
	return makeRequestEvent("http://localhost/api/account/login-history", {
	  locals,
	  request: null,
	});
}

describe("GET /api/account/login-history", () => {
	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});
});
