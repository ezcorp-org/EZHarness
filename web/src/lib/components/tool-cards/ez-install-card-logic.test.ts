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

	// The card's copy asserts the extension "is installed and enabled".
	// Keying only on `openUrl` meant one host change that emitted a
	// deep-link next to a failure would render a green success card for
	// a failed install. Pin that the parser reads `ok`.
	test("ok:false + a present openUrl → null (never a success card for a failure)", () => {
		expect(
			parseInstallCardResult(
				JSON.stringify({
					ok: false,
					code: "ENABLE_FAILED",
					name: "weather",
					openUrl: "/extensions/weather",
				}),
			),
		).toBeNull();
	});

	test("ok:true + openUrl still renders (the fix does not break the happy path)", () => {
		const r = parseInstallCardResult(
			JSON.stringify({ ok: true, name: "weather", openUrl: "/extensions/weather" }),
		);
		expect(r?.openUrl).toBe("/extensions/weather");
		expect(r?.title).toBe('Extension "weather" installed');
	});

	test("`ok` absent → still renders (legacy hosts that omit the flag)", () => {
		const r = parseInstallCardResult(
			JSON.stringify({ name: "weather", openUrl: "/extensions/weather" }),
		);
		expect(r?.openUrl).toBe("/extensions/weather");
	});
});
