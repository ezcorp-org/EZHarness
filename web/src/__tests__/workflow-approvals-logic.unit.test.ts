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
	describeAge,
	describeDeadline,
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

describe("describeDeadline — an approval that expires must SAY so", () => {
	const now = new Date("2026-07-30T12:00:00.000Z");

	test("no expiry renders nothing rather than a fake deadline", () => {
		expect(describeDeadline(null, now)).toBeNull();
	});

	test("an already-passed expiry says so, never 'in -3 hours'", () => {
		const d = describeDeadline("2026-07-30T09:00:00.000Z", now)!;
		expect(d.urgent).toBe(true);
		expect(d.text).toContain("Past deadline");
		expect(d.text).not.toContain("-");
	});

	test("a passed expiry does not claim the run was failed", () => {
		// Only `onTimeout: abort` fails the run; `approve` and `skip` carry
		// it on. The inbox reads a row that does not carry the policy, so
		// naming ANY of the three outcomes here would be a guess rendered
		// as a fact.
		const text = describeDeadline("2026-07-30T09:00:00.000Z", now)!.text;
		expect(text).not.toContain("failed");
		expect(text).not.toContain("cancelled");
		expect(text).not.toContain("approved");
	});

	test("under an hour is urgent", () => {
		expect(describeDeadline("2026-07-30T12:30:00.000Z", now)).toEqual({
			text: "Expires in 30 min",
			urgent: true,
		});
	});

	test("under four hours is still urgent; beyond that it is not", () => {
		expect(describeDeadline("2026-07-30T15:00:00.000Z", now)?.urgent).toBe(true);
		expect(describeDeadline("2026-07-30T22:00:00.000Z", now)?.urgent).toBe(false);
	});

	test("days are rendered in days", () => {
		expect(describeDeadline("2026-08-02T12:00:00.000Z", now)?.text).toBe("Expires in 3d");
	});
});

describe("describeAge", () => {
	const now = new Date("2026-07-30T12:00:00.000Z");

	test("renders how long a decision has been blocking", () => {
		expect(describeAge("2026-07-30T11:59:30.000Z", now)).toBe("just now");
		expect(describeAge("2026-07-30T11:30:00.000Z", now)).toBe("30 min ago");
		expect(describeAge("2026-07-30T09:00:00.000Z", now)).toBe("3h ago");
		expect(describeAge("2026-07-28T12:00:00.000Z", now)).toBe("2d ago");
	});

	test("a future createdAt clamps to 'just now' rather than going negative", () => {
		// Clock skew between the host and the browser is real; "-4 min ago"
		// would look like a bug in the data rather than in the clock.
		expect(describeAge("2026-07-30T12:05:00.000Z", now)).toBe("just now");
	});
});
