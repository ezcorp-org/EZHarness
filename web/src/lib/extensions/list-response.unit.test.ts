import { describe, expect, test } from "vitest";
import { extensionListFromResponse } from "./list-response.ts";

describe("extensionListFromResponse", () => {
	test("normalizes supported bare and wrapped extension responses", () => {
		const extension = { id: "ext-1", name: "calendar" };
		expect(extensionListFromResponse([extension])).toEqual([extension]);
		expect(extensionListFromResponse({ extensions: [extension] })).toEqual([extension]);
	});

	test("rejects malformed response envelopes", () => {
		expect(extensionListFromResponse({ extensions: "calendar" })).toEqual([]);
		expect(extensionListFromResponse(null)).toEqual([]);
	});
});
