/**
 * Unit tests for preprocess-result-logic.ts — the parse + synthesize
 * bridge between a persisted `preprocess-result` message row and the
 * tool-card router. Pure logic, no DOM.
 */
import { describe, expect, test } from "vitest";
import {
	parsePreprocessResult,
	parsePreprocessToolCall,
	toToolCallState,
} from "./preprocess-result-logic";

const OK_ROW = {
	extensionName: "graded-card-scanner",
	toolName: "identify_slab",
	cardType: "grade-delta-chart",
	ok: true,
	output: '{"cert":"49392223"}',
};

describe("parsePreprocessResult", () => {
	test("parses a well-formed row", () => {
		expect(parsePreprocessResult(JSON.stringify(OK_ROW))).toEqual(OK_ROW);
	});

	test("cardType is optional", () => {
		const { cardType: _omit, ...noCard } = OK_ROW;
		expect(parsePreprocessResult(JSON.stringify(noCard))).toEqual(noCard);
	});

	test("malformed JSON / non-object / array → null", () => {
		expect(parsePreprocessResult("{not-json")).toBeNull();
		expect(parsePreprocessResult('"a string"')).toBeNull();
		expect(parsePreprocessResult("[1,2]")).toBeNull();
		expect(parsePreprocessResult("null")).toBeNull();
	});

	test("missing/blank required fields → null", () => {
		expect(parsePreprocessResult(JSON.stringify({ ...OK_ROW, extensionName: "" }))).toBeNull();
		expect(parsePreprocessResult(JSON.stringify({ ...OK_ROW, toolName: undefined }))).toBeNull();
		expect(parsePreprocessResult(JSON.stringify({ ...OK_ROW, ok: "yes" }))).toBeNull();
		expect(parsePreprocessResult(JSON.stringify({ ...OK_ROW, output: 42 }))).toBeNull();
	});

	test("non-string cardType → null (shape violation, not silently dropped)", () => {
		expect(parsePreprocessResult(JSON.stringify({ ...OK_ROW, cardType: 7 }))).toBeNull();
	});
});

describe("toToolCallState", () => {
	test("ok:true → complete state with the declared cardType", () => {
		expect(toToolCallState(OK_ROW)).toEqual({
			toolName: "graded-card-scanner__identify_slab",
			status: "complete",
			output: '{"cert":"49392223"}',
			startedAt: 0,
			cardType: "grade-delta-chart",
		});
	});

	test("ok:true without cardType omits the key (router → DefaultCard)", () => {
		const { cardType: _omit, ...noCard } = OK_ROW;
		const state = toToolCallState(noCard);
		expect("cardType" in state).toBe(false);
		expect(state.status).toBe("complete");
	});

	test("ok:false → error state, NO cardType (DefaultCard error rendering)", () => {
		const state = toToolCallState({ ...OK_ROW, ok: false, output: "decode failed" });
		expect(state).toEqual({
			toolName: "graded-card-scanner__identify_slab",
			status: "error",
			error: "decode failed",
			output: "decode failed",
			startedAt: 0,
		});
	});
});

describe("parsePreprocessToolCall", () => {
	test("one-step happy path", () => {
		const state = parsePreprocessToolCall(JSON.stringify(OK_ROW));
		expect(state?.cardType).toBe("grade-delta-chart");
		expect(state?.status).toBe("complete");
	});

	test("unreadable content → null", () => {
		expect(parsePreprocessToolCall("{broken")).toBeNull();
	});
});
