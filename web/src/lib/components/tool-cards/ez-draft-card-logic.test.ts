/**
 * `parseDraftCardResult` — the `create_extension` (`cardType:
 * "ez-draft"`) result card.
 *
 * The defect it fixes: create_extension declared no cardType, so its
 * only actionable output — the `/extensions/author?prefill=<draftId>`
 * deep-link — rendered inside a collapsed DefaultCard whose 50-char
 * header preview truncated the URL away, and expanding showed it as
 * plain text in a `<pre>`, never a link.
 */

import { test, expect, describe } from "bun:test";
import { parseDraftCardResult } from "./ez-draft-card-logic.js";

const OPEN_URL = "/extensions/author?prefill=draft-abc";

describe("parseDraftCardResult", () => {
	test("full create_extension payload → renderable card with the deep-link", () => {
		const r = parseDraftCardResult(
			JSON.stringify({
				draftId: "draft-abc",
				openUrl: OPEN_URL,
				name: "weather",
				type: "tool",
			}),
		);
		expect(r).not.toBeNull();
		expect(r?.openUrl).toBe(OPEN_URL);
		expect(r?.draftId).toBe("draft-abc");
		expect(r?.openUrlLabel).toBe("Open draft editor");
		expect(r?.title).toBe("Draft ready: weather");
		expect(r?.summary).toContain("weather");
		expect(r?.summary).toContain("(tool)");
	});

	test("name without type → title/summary still name the draft", () => {
		const r = parseDraftCardResult(
			JSON.stringify({ openUrl: OPEN_URL, name: "weather" }),
		);
		expect(r?.title).toBe("Draft ready: weather");
		expect(r?.summary).not.toContain("(");
	});

	test("no name → generic copy, still renders because openUrl is usable", () => {
		const r = parseDraftCardResult(JSON.stringify({ openUrl: OPEN_URL }));
		expect(r?.title).toBe("Extension draft ready");
		expect(r?.summary).toBe("Review and edit the scaffolded files, then install.");
		expect(r?.draftId).toBeUndefined();
	});

	test("MCP text envelope is unwrapped like the sibling cards", () => {
		const r = parseDraftCardResult({
			content: [{ type: "text", text: JSON.stringify({ openUrl: OPEN_URL, name: "w" }) }],
		});
		expect(r?.openUrl).toBe(OPEN_URL);
	});

	test("ok:false never renders as a success card", () => {
		expect(
			parseDraftCardResult(
				JSON.stringify({ ok: false, openUrl: OPEN_URL, name: "weather" }),
			),
		).toBeNull();
	});

	test("missing / empty openUrl → null (router falls back to DefaultCard)", () => {
		expect(parseDraftCardResult(JSON.stringify({ name: "weather" }))).toBeNull();
		expect(parseDraftCardResult(JSON.stringify({ openUrl: "" }))).toBeNull();
		expect(parseDraftCardResult(JSON.stringify({ openUrl: 42 }))).toBeNull();
	});

	test("null / undefined / scalar / malformed JSON → null", () => {
		expect(parseDraftCardResult(null)).toBeNull();
		expect(parseDraftCardResult(undefined)).toBeNull();
		expect(parseDraftCardResult(42)).toBeNull();
		expect(parseDraftCardResult("not json at all")).toBeNull();
		expect(parseDraftCardResult("[1,2]")).toBeNull();
	});
});
