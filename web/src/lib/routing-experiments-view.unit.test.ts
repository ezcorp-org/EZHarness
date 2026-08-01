/**
 * Unit tests for the routing-experiments view helpers.
 *
 * The point of this module is that it does NOT restate the backend's rules —
 * so these tests check the two things it really owns (the percent↔probability
 * conversion, and the sentence that describes what a rate costs) and then
 * check that the rejection paths carry the BACKEND's wording through, since a
 * paraphrase here would be the drift the module exists to prevent.
 */
import { describe, test, expect } from "vitest";
import {
	explorationImpact,
	HIGH_EXPLORATION_RATE,
	needsAcknowledgement,
	percentFromRate,
	rateFromPercent,
	readShadowForm,
	saveErrorMessage,
	shadowFormFrom,
	shadowUnchanged,
} from "./routing-experiments-view.js";
import { validateShadowThresholds } from "$server/runtime/routing/shadow";

describe("percentFromRate", () => {
	test("off reads as an empty box, not a zero", () => {
		expect(percentFromRate(0)).toBeNull();
	});

	test("a stored probability shows as its percentage", () => {
		expect(percentFromRate(0.05)).toBe(5);
		expect(percentFromRate(1)).toBe(100);
	});

	test("the ×100 rounds, so a stored 0.087 does not read as 8.700000000000001", () => {
		expect(percentFromRate(0.087)).toBe(8.7);
	});
});

describe("rateFromPercent", () => {
	test("an empty box is OFF, not an error — clearing it turns exploration off", () => {
		expect(rateFromPercent(null)).toEqual({ ok: true, rate: 0 });
	});

	test("a value the number input could not parse is treated as off", () => {
		expect(rateFromPercent(Number.NaN)).toEqual({ ok: true, rate: 0 });
	});

	test("a percentage converts to the stored probability", () => {
		expect(rateFromPercent(5)).toEqual({ ok: true, rate: 0.05 });
		expect(rateFromPercent(0)).toEqual({ ok: true, rate: 0 });
		expect(rateFromPercent(100)).toEqual({ ok: true, rate: 1 });
	});

	test("the ÷100 rounds, so 8.7% stores 0.087 exactly", () => {
		expect(rateFromPercent(8.7)).toEqual({ ok: true, rate: 0.087 });
	});

	test("out of range is rejected IN PERCENT, since that is the unit typed", () => {
		expect(rateFromPercent(150)).toEqual({
			ok: false,
			error: "150% is not a share of traffic — enter 0 to 100",
		});
		expect(rateFromPercent(-5)).toEqual({
			ok: false,
			error: "-5% is not a share of traffic — enter 0 to 100",
		});
	});
});

describe("needsAcknowledgement", () => {
	test("only an INCREASE has to be acknowledged", () => {
		expect(needsAcknowledgement(0, 0.05)).toBe(true);
		expect(needsAcknowledgement(0.05, 0.1)).toBe(true);
	});

	test("turning it down or off never is", () => {
		expect(needsAcknowledgement(0.1, 0.05)).toBe(false);
		expect(needsAcknowledgement(0.05, 0)).toBe(false);
		expect(needsAcknowledgement(0.05, 0.05)).toBe(false);
	});
});

describe("explorationImpact", () => {
	test("off says nothing is downgraded", () => {
		const impact = explorationImpact(0);
		expect(impact.level).toBe("off");
		expect(impact.text).toContain("Off");
		expect(impact.text).toContain("classifier picked");
	});

	test("a modest rate is spelled out in turns, with the quality cost named", () => {
		const impact = explorationImpact(0.05);
		expect(impact.level).toBe("on");
		expect(impact.text).toContain("About 1 in 20 routed turns");
		expect(impact.text).toContain("one tier BELOW");
		expect(impact.text).toContain("Some of those answers will be worse");
	});

	test("past the high-water mark it reads louder", () => {
		expect(explorationImpact(HIGH_EXPLORATION_RATE).level).toBe("on");
		expect(explorationImpact(HIGH_EXPLORATION_RATE + 0.01).level).toBe("high");
	});

	test("100% says EVERY turn rather than 1 in 1", () => {
		const impact = explorationImpact(1);
		expect(impact.level).toBe("high");
		expect(impact.text).toMatch(/^Every routed turn/);
	});
});

describe("shadowFormFrom", () => {
	test("an unset candidate is two empty boxes", () => {
		expect(shadowFormFrom(undefined)).toEqual({ fastMaxTokens: null, powerfulMinTokens: null });
	});

	test("a stored candidate fills both boxes", () => {
		expect(shadowFormFrom({ fastMaxTokens: 250, powerfulMinTokens: 4000 })).toEqual({
			fastMaxTokens: 250,
			powerfulMinTokens: 4000,
		});
	});
});

describe("readShadowForm", () => {
	test("both boxes empty is OFF, not an error", () => {
		expect(readShadowForm({ fastMaxTokens: null, powerfulMinTokens: null })).toEqual({
			kind: "empty",
		});
	});

	test("half a pair asks for the other half instead of blaming one field", () => {
		const error = "Set both thresholds, or clear both to turn shadow mode off.";
		expect(readShadowForm({ fastMaxTokens: 250, powerfulMinTokens: null })).toEqual({
			kind: "invalid",
			error,
		});
		expect(readShadowForm({ fastMaxTokens: null, powerfulMinTokens: 4000 })).toEqual({
			kind: "invalid",
			error,
		});
	});

	test("a well-formed pair is the candidate to save", () => {
		expect(readShadowForm({ fastMaxTokens: 250, powerfulMinTokens: 4000 })).toEqual({
			kind: "valid",
			thresholds: { fastMaxTokens: 250, powerfulMinTokens: 4000 },
		});
	});

	test("an inverted pair surfaces the SERVER's own explanation, verbatim", () => {
		const form = { fastMaxTokens: 5000, powerfulMinTokens: 400 };
		const fromServer = validateShadowThresholds(form);
		expect(fromServer.ok).toBe(false);
		expect(readShadowForm(form)).toEqual({
			kind: "invalid",
			// Not a paraphrase: the operator reads exactly what a 400 would say.
			error: fromServer.ok ? "" : fromServer.error,
		});
	});

	test("a non-integer threshold is rejected by the same shared validator", () => {
		const result = readShadowForm({ fastMaxTokens: 2.5, powerfulMinTokens: 4000 });
		expect(result).toEqual({
			kind: "invalid",
			error: "fastMaxTokens must be a positive whole number of tokens",
		});
	});
});

describe("shadowUnchanged", () => {
	test("true when the boxes still hold the stored candidate", () => {
		const stored = { fastMaxTokens: 250, powerfulMinTokens: 4000 };
		expect(shadowUnchanged({ fastMaxTokens: 250, powerfulMinTokens: 4000 }, stored)).toBe(true);
		expect(shadowUnchanged({ fastMaxTokens: null, powerfulMinTokens: null }, undefined)).toBe(true);
	});

	test("false once either box moves", () => {
		const stored = { fastMaxTokens: 250, powerfulMinTokens: 4000 };
		expect(shadowUnchanged({ fastMaxTokens: 300, powerfulMinTokens: 4000 }, stored)).toBe(false);
		expect(shadowUnchanged({ fastMaxTokens: 250, powerfulMinTokens: 5000 }, stored)).toBe(false);
		expect(shadowUnchanged({ fastMaxTokens: 250, powerfulMinTokens: 4000 }, undefined)).toBe(false);
	});
});

describe("saveErrorMessage", () => {
	test("the route's rejection message wins — it is the only WHY there is", () => {
		expect(saveErrorMessage(new Error("Invalid provider:routingShadow: inverted"))).toBe(
			"Invalid provider:routingShadow: inverted",
		);
	});

	test("a failure with nothing to say still says the row is unchanged", () => {
		const generic = "Save failed — the setting was not changed.";
		expect(saveErrorMessage(new Error(""))).toBe(generic);
		expect(saveErrorMessage("network down")).toBe(generic);
	});
});
