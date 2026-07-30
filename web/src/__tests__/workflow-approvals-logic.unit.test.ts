/**
 * Pure decision rules behind the approvals inbox.
 *
 * These are split out of the page precisely so they can be asserted
 * without mounting Svelte — the consent rules are the part that can be
 * WRONG rather than merely ugly.
 */
import { test, expect, describe } from "vitest";
import {
	buildAnswerBody,
	canSubmit,
	describeOutcome,
	toggleItem,
} from "../lib/workflow-approvals-logic";

const plain = { requireItemConsent: false };
const consent = { requireItemConsent: true };

describe("buildAnswerBody", () => {
	test("a plain approval sends the choice and NO itemIds", () => {
		expect(buildAnswerBody(plain, "approve", [])).toEqual({ choice: "approve" });
		// Even if a stale selection is lying around, it must not be sent:
		// the server would then record item consent nobody was asked for.
		expect(buildAnswerBody(plain, "approve", ["a", "b"])).toEqual({ choice: "approve" });
	});

	test("a consent approval sends exactly what was TICKED, never the offered list", () => {
		// Echoing the offered list back would turn "consent to these three"
		// into "consent to whatever you asked about", which is the entire
		// thing `requireItemConsent` exists to prevent.
		expect(buildAnswerBody(consent, "approve", ["a"])).toEqual({
			choice: "approve",
			itemIds: ["a"],
		});
	});

	test("a consent approval with nothing ticked sends an EMPTY list, not a full one", () => {
		// The server-side guard refuses this. The UI must not paper over
		// that refusal by inventing a selection.
		expect(buildAnswerBody(consent, "approve", [])).toEqual({ choice: "approve", itemIds: [] });
	});
});

describe("canSubmit", () => {
	test("a plain approval is submittable immediately", () => {
		expect(canSubmit(plain, [], false)).toBe(true);
	});

	test("a consent approval needs at least one ticked item", () => {
		expect(canSubmit(consent, [], false)).toBe(false);
		expect(canSubmit(consent, ["a"], false)).toBe(true);
	});

	test("an in-flight answer blocks a second one, consent or not", () => {
		// A double-click must not answer twice. The CAS behind the answer
		// path makes the second a clean loss, but a UI that fires it at all
		// tells the user their decision failed when it did not.
		expect(canSubmit(plain, [], true)).toBe(false);
		expect(canSubmit(consent, ["a"], true)).toBe(false);
	});
});

describe("toggleItem", () => {
	test("adds, removes, and never mutates the input", () => {
		const before = ["a"];
		expect(toggleItem(before, "b")).toEqual(["a", "b"]);
		expect(toggleItem(before, "a")).toEqual([]);
		// A new array is what makes the checkbox actually re-render — an
		// in-place push on a `$state` member is the classic silent no-op.
		expect(before).toEqual(["a"]);
		expect(toggleItem(before, "b")).not.toBe(before);
	});
});

describe("describeOutcome", () => {
	test("reports the RUN's fate, not merely that the POST returned 200", () => {
		// An answer can be recorded while the run then fails to continue.
		// Saying "answered" and stopping there would hide that.
		expect(describeOutcome("success")).toMatchObject({ tone: "ok" });
		expect(describeOutcome("running")).toMatchObject({ tone: "ok" });
		expect(describeOutcome("error").tone).toBe("error");
		expect(describeOutcome("error").text).toContain("error");
	});

	test("suspended after an answer is PROGRESS — the next approval — not a failure", () => {
		const o = describeOutcome("suspended");
		expect(o.tone).toBe("ok");
		expect(o.text).toContain("next approval");
	});

	test("an absent status is reported as unknown rather than assumed good", () => {
		expect(describeOutcome(undefined)).toMatchObject({ tone: "warn" });
	});
});
