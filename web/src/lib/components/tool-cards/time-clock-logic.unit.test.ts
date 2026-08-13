import { describe, expect, test } from "vitest";
import {
	formatClockDate,
	formatClockDateLabel,
	formatClockTime,
	getClockParts,
	isTimeClockOutput,
	parseTimeClockPayload,
	type TimeClockPayload,
} from "./time-clock-logic.js";

const payload: TimeClockPayload = {
	cardType: "time-clock",
	label: "Current time · UTC",
	formatted: "Monday, May 18, 2026 at 9:40:08 PM UTC",
	timezone: "UTC",
	locale: "en-US",
	iso: "2026-05-18T21:40:08.000Z",
	hour12: false,
};

describe("time-clock payload parsing", () => {
	test("accepts JSON strings and tool-result envelopes", () => {
		expect(parseTimeClockPayload(JSON.stringify(payload))?.timezone).toBe("UTC");
		expect(parseTimeClockPayload({
			content: [{ type: "text", text: JSON.stringify(payload) }],
			isError: false,
		})?.locale).toBe("en-US");
	});

	test("accepts a top-level envelope cardType and rejects malformed data", () => {
		const { cardType: _cardType, ...withoutCardType } = payload;
		expect(parseTimeClockPayload({
			cardType: "time-clock",
			content: [{ type: "text", text: JSON.stringify(withoutCardType) }],
		})).not.toBeNull();
		expect(parseTimeClockPayload("not json")).toBeNull();
		expect(parseTimeClockPayload(JSON.stringify({ ...payload, iso: "invalid" }))).toBeNull();
		expect(isTimeClockOutput(JSON.stringify(payload))).toBe(true);
	});
});

describe("live wall-clock formatting", () => {
	const date = new Date("2026-05-18T21:40:08.000Z");

	test("calculates analog hand angles", () => {
		const parts = getClockParts(date, "en-US", "UTC");
		expect(parts).toMatchObject({ hour: 21, minute: 40, second: 8 });
		expect(parts.hourAngle).toBeCloseTo(290.0667, 3);
		expect(parts.minuteAngle).toBeCloseTo(240.8, 3);
		expect(parts.secondAngle).toBe(48);
	});

	test("keeps hand angles numeric for locales that display non-Latin digits", () => {
		const parts = getClockParts(date, "ar-EG", "UTC");
		expect(parts).toMatchObject({ hour: 21, minute: 40, second: 8 });
		expect(parts.hourAngle).toBeCloseTo(290.0667, 3);
		expect(parts.minuteAngle).toBeCloseTo(240.8, 3);
		expect(parts.secondAngle).toBe(48);
		expect([
			parts.hourAngle,
			parts.minuteAngle,
			parts.secondAngle,
		].every(Number.isFinite)).toBe(true);
	});

	test("formats digital time and date independently for every locale", () => {
		expect(formatClockTime(date, payload)).toContain("21:40:08");
		expect(formatClockDateLabel(date, payload)).toContain("Monday");
		expect(formatClockDate(date, payload)).toContain("21:40:08");

		const japanese = { ...payload, locale: "ja-JP", timezone: "Asia/Tokyo" };
		expect(formatClockTime(date, japanese)).toContain("6:40:08");
		expect(formatClockDateLabel(date, japanese)).toContain("2026");
	});
});
