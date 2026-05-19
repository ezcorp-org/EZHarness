import { test, expect, describe } from "bun:test";
import {
  getDeclaredDefaults,
  clampSettings,
} from "../extension-settings";
import type { SettingsSchema } from "../../../extensions/types";

const FULL_SCHEMA: SettingsSchema = {
  voice: {
    type: "select",
    label: "Voice",
    options: [
      { value: "af_bella", label: "Bella" },
      { value: "am_adam", label: "Adam" },
    ],
    default: "af_bella",
  },
  greeting: {
    type: "text",
    label: "Greeting",
    default: "hello",
    minLength: 2,
    maxLength: 8,
    pattern: "^[a-z]+$",
  },
  speed: {
    type: "number",
    label: "Speed",
    default: 1.0,
    min: 0.5,
    max: 2.0,
  },
  count: {
    type: "number",
    label: "Count",
    default: 3,
    min: 1,
    max: 10,
    integer: true,
  },
  loop: {
    type: "boolean",
    label: "Loop",
    default: false,
  },
  noDefault: {
    type: "text",
    label: "No default",
  },
};

describe("getDeclaredDefaults", () => {
  test("returns each field's default", () => {
    expect(getDeclaredDefaults(FULL_SCHEMA)).toEqual({
      voice: "af_bella",
      greeting: "hello",
      speed: 1.0,
      count: 3,
      loop: false,
    });
  });

  test("omits fields without defaults", () => {
    const defaults = getDeclaredDefaults(FULL_SCHEMA);
    expect("noDefault" in defaults).toBe(false);
  });

  test("returns empty object for undefined schema", () => {
    expect(getDeclaredDefaults(undefined)).toEqual({});
  });

  test("returns empty object for empty schema", () => {
    expect(getDeclaredDefaults({})).toEqual({});
  });
});

describe("clampSettings — empty/undefined inputs", () => {
  test("returns {} when schema is undefined", () => {
    expect(clampSettings(undefined, { voice: "af_bella" })).toEqual({});
  });

  test("returns {} when values is null", () => {
    expect(clampSettings(FULL_SCHEMA, null)).toEqual({});
  });

  test("returns {} when values is undefined", () => {
    expect(clampSettings(FULL_SCHEMA, undefined)).toEqual({});
  });

  test("returns {} when values is an array", () => {
    expect(clampSettings(FULL_SCHEMA, ["voice"])).toEqual({});
  });

  test("returns {} when values is a primitive", () => {
    expect(clampSettings(FULL_SCHEMA, "not-an-object")).toEqual({});
  });
});

describe("clampSettings — drops unknown keys", () => {
  test("strips keys not declared in schema", () => {
    const cleaned = clampSettings(FULL_SCHEMA, {
      voice: "af_bella",
      mystery: "ignored",
      another: 42,
    });
    expect(cleaned).toEqual({ voice: "af_bella" });
  });

  test("returns {} when nothing remains after clamp", () => {
    const cleaned = clampSettings(FULL_SCHEMA, { unknown: 1, alsoUnknown: 2 });
    expect(cleaned).toEqual({});
  });
});

describe("clampSettings — accepts valid values across all field types", () => {
  test("admits valid values for select/text/number/boolean", () => {
    const cleaned = clampSettings(FULL_SCHEMA, {
      voice: "am_adam",
      greeting: "hola",
      speed: 1.25,
      count: 5,
      loop: true,
    });
    expect(cleaned).toEqual({
      voice: "am_adam",
      greeting: "hola",
      speed: 1.25,
      count: 5,
      loop: true,
    });
  });
});

describe("clampSettings — select rules", () => {
  test("drops value not in options", () => {
    expect(
      clampSettings(FULL_SCHEMA, { voice: "bx_unknown" }),
    ).toEqual({});
  });

  test("drops non-string select value", () => {
    expect(clampSettings(FULL_SCHEMA, { voice: 123 })).toEqual({});
  });
});

describe("clampSettings — text rules", () => {
  test("drops non-string", () => {
    expect(clampSettings(FULL_SCHEMA, { greeting: 5 })).toEqual({});
  });

  test("drops too-short string", () => {
    expect(clampSettings(FULL_SCHEMA, { greeting: "a" })).toEqual({});
  });

  test("drops too-long string", () => {
    expect(
      clampSettings(FULL_SCHEMA, { greeting: "abcdefghi" }),
    ).toEqual({});
  });

  test("drops string failing pattern", () => {
    expect(clampSettings(FULL_SCHEMA, { greeting: "HELLO" })).toEqual({});
  });

  test("admits boundary values (minLength + maxLength + pattern)", () => {
    expect(clampSettings(FULL_SCHEMA, { greeting: "ab" })).toEqual({
      greeting: "ab",
    });
    expect(clampSettings(FULL_SCHEMA, { greeting: "abcdefgh" })).toEqual({
      greeting: "abcdefgh",
    });
  });

  test("drops value when pattern is not a valid regex", () => {
    const broken: SettingsSchema = {
      x: { type: "text", label: "X", pattern: "(unclosed" },
    };
    expect(clampSettings(broken, { x: "abc" })).toEqual({});
  });

  test("admits text without bounds", () => {
    const open: SettingsSchema = { note: { type: "text", label: "Note" } };
    expect(clampSettings(open, { note: "anything goes!" })).toEqual({
      note: "anything goes!",
    });
  });
});

describe("clampSettings — number rules", () => {
  test("drops non-number", () => {
    expect(clampSettings(FULL_SCHEMA, { speed: "1.5" })).toEqual({});
  });

  test("drops NaN / Infinity", () => {
    expect(clampSettings(FULL_SCHEMA, { speed: NaN })).toEqual({});
    expect(clampSettings(FULL_SCHEMA, { speed: Infinity })).toEqual({});
  });

  test("drops below min", () => {
    expect(clampSettings(FULL_SCHEMA, { speed: 0.1 })).toEqual({});
  });

  test("drops above max", () => {
    expect(clampSettings(FULL_SCHEMA, { speed: 3.0 })).toEqual({});
  });

  test("drops non-integer when integer:true", () => {
    expect(clampSettings(FULL_SCHEMA, { count: 2.5 })).toEqual({});
  });

  test("admits boundary values (min and max)", () => {
    expect(clampSettings(FULL_SCHEMA, { speed: 0.5 })).toEqual({ speed: 0.5 });
    expect(clampSettings(FULL_SCHEMA, { speed: 2.0 })).toEqual({ speed: 2.0 });
  });

  test("admits integer when integer:true", () => {
    expect(clampSettings(FULL_SCHEMA, { count: 7 })).toEqual({ count: 7 });
  });

  test("admits unbounded numbers", () => {
    const open: SettingsSchema = {
      ratio: { type: "number", label: "Ratio" },
    };
    expect(clampSettings(open, { ratio: -1000 })).toEqual({ ratio: -1000 });
  });
});

describe("clampSettings — boolean rules", () => {
  test("drops non-boolean", () => {
    expect(clampSettings(FULL_SCHEMA, { loop: "true" })).toEqual({});
    expect(clampSettings(FULL_SCHEMA, { loop: 1 })).toEqual({});
    expect(clampSettings(FULL_SCHEMA, { loop: null })).toEqual({});
  });

  test("admits true and false", () => {
    expect(clampSettings(FULL_SCHEMA, { loop: true })).toEqual({ loop: true });
    expect(clampSettings(FULL_SCHEMA, { loop: false })).toEqual({
      loop: false,
    });
  });
});
