/**
 * Server-handler unit test for /api/account/login-history/+server.ts.
 * Auth gate only — success path lists audit-log rows from the DB.
 */

import { test, expect, describe } from "vitest";
import { GET } from "../routes/api/account/login-history/+server";

function makeEvent(locals: Record<string, unknown> = {}) {
	return {
		url: new URL("http://localhost/api/account/login-history"),
		locals,
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		const out = await fn();
		res = out;
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res).toBeInstanceOf(Response);
	expect(res!.status).toBe(status);
	return res!;
}

describe("GET /api/account/login-history", () => {
	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});
});
