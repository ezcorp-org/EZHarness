import { describe, expect, test } from "bun:test";
import manifest from "./ezcorp.config";
import { buildTimeClockPayload, tools } from "./index";

function textOf(output: unknown): string {
  const first = (output as { content?: Array<{ type: string; text: string }> }).content?.[0];
  if (!first || first.type !== "text") throw new Error("tool result is missing text content");
  return first.text;
}

function isError(output: unknown): boolean {
  return (output as { isError?: boolean }).isError === true;
}

describe("time-teller manifest", () => {
  test("declares the live clock card and deterministic smoke test", () => {
    expect(manifest.name).toBe("time-teller");
    expect(manifest.tools?.[0]?.name).toBe("tell-time");
    expect(manifest.tools?.[0]?.cardType).toBe("time-clock");
    expect(manifest.smokeTest?.tool).toBe("tell-time");
    expect(manifest.permissions).toEqual({});
  });
});

describe("buildTimeClockPayload", () => {
  test("formats a fixed instant in UTC", () => {
    const payload = buildTimeClockPayload(new Date("2026-05-18T21:40:08.000Z"), {
      timezone: "UTC",
      locale: "en-US",
      hour12: false,
    });

    expect(payload.cardType).toBe("time-clock");
    expect(payload.timezone).toBe("UTC");
    expect(payload.locale).toBe("en-US");
    expect(payload.iso).toBe("2026-05-18T21:40:08.000Z");
    expect(payload.formatted).toContain("21:40:08");
    expect(payload.currentTimeText).toContain(payload.formatted);
    expect(payload._assistant_note).toMatch(/updates every second/i);
  });

  test("converts the same instant into another timezone", () => {
    const payload = buildTimeClockPayload(new Date("2026-05-18T21:40:08.000Z"), {
      timezone: "America/New_York",
      locale: "en-US",
      hour12: true,
    });

    expect(payload.formatted).toMatch(/5:40:08\s*PM/i);
    expect(payload.label).toContain("America/New_York");
  });
});

describe("tell-time tool", () => {
  test("returns a renderable time-clock payload with UTC defaults", async () => {
    const output = await tools["tell-time"]!({});
    expect(isError(output)).toBe(false);

    const payload = JSON.parse(textOf(output));
    expect(payload.cardType).toBe("time-clock");
    expect(payload.timezone).toBe("UTC");
    expect(payload.locale).toBe("en-US");
    expect(Number.isNaN(Date.parse(payload.iso))).toBe(false);
  });

  test("honors timezone, locale, and hour format", async () => {
    const output = await tools["tell-time"]!({
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
      hour12: false,
    });
    const payload = JSON.parse(textOf(output));

    expect(isError(output)).toBe(false);
    expect(payload.timezone).toBe("Asia/Tokyo");
    expect(payload.locale).toBe("ja-JP");
    expect(payload.hour12).toBe(false);
  });

  test("rejects invalid timezone, locale, and hour12 inputs", async () => {
    const badTimezone = await tools["tell-time"]!({ timezone: "Mars/Olympus" });
    expect(isError(badTimezone)).toBe(true);
    expect(textOf(badTimezone)).toMatch(/IANA timezone/i);

    const badLocale = await tools["tell-time"]!({ locale: "not_a_locale" });
    expect(isError(badLocale)).toBe(true);
    expect(textOf(badLocale)).toMatch(/locale/i);

    const badHour12 = await tools["tell-time"]!({ hour12: "yes" });
    expect(isError(badHour12)).toBe(true);
    expect(textOf(badHour12)).toMatch(/boolean/i);
  });
});
