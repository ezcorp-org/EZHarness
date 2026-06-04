/**
 * Pure-logic tests for the expose-consent card (Secure Preview Phase 2).
 * Run from web/ with `bunx vitest run`.
 */
import { describe, test, expect } from "vitest";
import {
	parseConsentCardResult,
	buildConsentRequest,
	buildOpenUrl,
} from "./preview-consent-card-logic.js";

describe("parseConsentCardResult", () => {
	test("parses a JSON-string payload", () => {
		const out = JSON.stringify({ conversationId: "c1", port: 5173, title: "T", summary: "S" });
		expect(parseConsentCardResult(out)).toEqual({
			conversationId: "c1",
			port: 5173,
			title: "T",
			summary: "S",
		});
	});

	test("parses a raw object payload", () => {
		expect(parseConsentCardResult({ conversationId: "c1", port: 3000 })).toEqual({
			conversationId: "c1",
			port: 3000,
			title: "A site started on port 3000",
			summary: "Expose it to your browser? Nothing is served until you choose.",
		});
	});

	test("unwraps an MCP content envelope", () => {
		const env = { content: [{ type: "text", text: JSON.stringify({ conversationId: "c2", port: 4321 }) }] };
		expect(parseConsentCardResult(env)).toMatchObject({ conversationId: "c2", port: 4321 });
	});

	test("returns null on missing/invalid fields", () => {
		expect(parseConsentCardResult(null)).toBeNull();
		expect(parseConsentCardResult("")).toBeNull();
		expect(parseConsentCardResult("not json")).toBeNull();
		expect(parseConsentCardResult({ port: 5173 })).toBeNull(); // no conv
		expect(parseConsentCardResult({ conversationId: "c1" })).toBeNull(); // no port
		expect(parseConsentCardResult({ conversationId: "c1", port: 0 })).toBeNull();
		expect(parseConsentCardResult({ conversationId: "c1", port: -1 })).toBeNull();
	});
});

describe("buildConsentRequest", () => {
	const data = { conversationId: "c1", port: 5173, title: "T", summary: "S" };
	test("composes the POST body for each action", () => {
		expect(buildConsentRequest(data, "expose")).toEqual({ conversationId: "c1", port: 5173, action: "expose" });
		expect(buildConsentRequest(data, "ignore")).toEqual({ conversationId: "c1", port: 5173, action: "ignore" });
		expect(buildConsentRequest(data, "always-expose")).toEqual({
			conversationId: "c1",
			port: 5173,
			action: "always-expose",
		});
	});
});

describe("buildOpenUrl", () => {
	test("composes <label>.preview.<host>/__open?c=<code>, stripping the app port", () => {
		expect(buildOpenUrl("abc26", "code123", "localhost:5173", "http:")).toBe(
			"http://abc26.preview.localhost/__open?c=code123",
		);
	});
	test("url-encodes the code + honors protocol/host", () => {
		expect(buildOpenUrl("xyz", "a/b+c", "app.example.com", "https:")).toBe(
			"https://xyz.preview.app.example.com/__open?c=a%2Fb%2Bc",
		);
	});
});
