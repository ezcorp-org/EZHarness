import { describe, expect, test } from "vitest";
import { parseMcpHeaders } from "./mcp-headers";

describe("parseMcpHeaders", () => {
	test("reads one header per line, keeping colons in values", () => {
		expect(parseMcpHeaders("Authorization: Bearer abc\r\nX-Route: a:b")).toEqual({
			Authorization: "Bearer abc",
			"X-Route": "a:b",
		});
	});

	test("skips lines without a colon or a name, and keeps a blank value", () => {
		expect(parseMcpHeaders("not a header\n: orphan\nX-Keep: \n")).toEqual({ "X-Keep": "" });
		expect(parseMcpHeaders("")).toEqual({});
	});
});
