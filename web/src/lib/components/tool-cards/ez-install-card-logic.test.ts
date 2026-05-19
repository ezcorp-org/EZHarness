import { describe, expect, test } from "bun:test";
import { parseInstallCardResult } from "./ez-install-card-logic.js";

describe("parseInstallCardResult", () => {
	test("parses the JSON-string output (the live `extractToolOutput` path)", () => {
		const r = parseInstallCardResult(
			JSON.stringify({
				ok: true,
				extensionId: "ext-42",
				name: "weather",
				openUrl: "/extensions/weather",
			}),
		);
		expect(r).not.toBeNull();
		expect(r?.openUrl).toBe("/extensions/weather");
		expect(r?.openUrlLabel).toBe("Open extension");
		expect(r?.title).toBe('Extension "weather" installed');
		expect(r?.summary).toContain("weather");
	});

	test("unwraps a defensive MCP content envelope (non-enveloped object path)", () => {
		const r = parseInstallCardResult({
			content: [
				{ type: "text", text: JSON.stringify({ name: "foo", openUrl: "/extensions/foo" }) },
			],
		});
		expect(r?.openUrl).toBe("/extensions/foo");
		expect(r?.title).toBe('Extension "foo" installed');
	});

	test("accepts a plain result object (no envelope, no string)", () => {
		const r = parseInstallCardResult({ name: "bar", openUrl: "/extensions/bar" });
		expect(r?.openUrl).toBe("/extensions/bar");
	});

	test("missing openUrl → null (router falls back to DefaultCard — today's behavior)", () => {
		expect(
			parseInstallCardResult(JSON.stringify({ ok: true, extensionId: "e", name: "x" })),
		).toBeNull();
	});

	test("empty-string openUrl → null", () => {
		expect(
			parseInstallCardResult(JSON.stringify({ name: "x", openUrl: "" })),
		).toBeNull();
	});

	test("name absent → generic title/summary, still renders if openUrl present", () => {
		const r = parseInstallCardResult(JSON.stringify({ openUrl: "/extensions/y" }));
		expect(r?.openUrl).toBe("/extensions/y");
		expect(r?.title).toBe("Extension installed");
		expect(r?.summary).toContain("Extensions Library");
	});

	test("null / undefined / non-object / malformed JSON → null", () => {
		expect(parseInstallCardResult(null)).toBeNull();
		expect(parseInstallCardResult(undefined)).toBeNull();
		expect(parseInstallCardResult(42)).toBeNull();
		expect(parseInstallCardResult("not json at all")).toBeNull();
		expect(parseInstallCardResult([1, 2, 3])).toBeNull();
	});

	test("envelope with non-text / unparseable text part → null", () => {
		expect(
			parseInstallCardResult({ content: [{ type: "image" }] }),
		).toBeNull();
		expect(
			parseInstallCardResult({ content: [{ type: "text", text: "{bad json" }] }),
		).toBeNull();
	});

	test("JSON string that parses to a non-object (array/scalar) → null", () => {
		expect(parseInstallCardResult("[1,2]")).toBeNull();
		expect(parseInstallCardResult('"just a string"')).toBeNull();
	});
});
