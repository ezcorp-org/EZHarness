// Validator coverage for the `settings` extension-manifest block. Drives
// the public `validateManifestV2` API with crafted manifests and asserts
// both the `valid` flag and the user-visible error strings.

import { test, expect, describe } from "bun:test";
import {
  isValidForField,
  SECRET_SETTING_MAX_LENGTH,
  validateManifestV2,
} from "../extensions/manifest";
import type {
  ExtensionManifestV2,
  SettingsField,
  SettingsSchema,
} from "../extensions/types";

function makeManifest(
  extra: Partial<ExtensionManifestV2> = {},
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "ext-name",
    version: "1.0.0",
    description: "test",
    author: { name: "test" },
    permissions: {},
    ...extra,
  };
}

describe("validateSettingsSchema — accepts each field type", () => {
  test("select with valid options + default", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          voice: {
            type: "select",
            label: "Voice",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
            default: "a",
          },
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("text with bounds + valid pattern + matching default", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          handle: {
            type: "text",
            label: "Handle",
            description: "Your username",
            minLength: 1,
            maxLength: 16,
            pattern: "^[a-z]+$",
            default: "abc",
          },
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("number with bounds + integer + valid default", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          rate: {
            type: "number",
            label: "Rate",
            min: 0,
            max: 10,
            step: 1,
            integer: true,
            default: 5,
          },
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("boolean with default true", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          notify: { type: "boolean", label: "Notify", default: true },
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("boolean with default false", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          notify: { type: "boolean", label: "Notify", default: false },
        },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("field without optional defaults still admits", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          plain: { type: "text", label: "Plain" },
        },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("unknown keys on a field are tolerated (forward-compat)", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          x: {
            type: "boolean",
            label: "X",
            // @ts-expect-error — unknown field for forward-compat
            futureKey: "ignored",
          },
        },
      }),
    );
    expect(r.valid).toBe(true);
  });
});

describe("validateSettingsSchema — top-level shape", () => {
  test("rejects settings as null", () => {
    const r = validateManifestV2(
      makeManifest({ settings: null as unknown as SettingsSchema }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings must be a plain object");
  });

  test("rejects settings as array", () => {
    const r = validateManifestV2(
      makeManifest({ settings: [] as unknown as SettingsSchema }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings must be a plain object");
  });

  test("rejects settings as a primitive", () => {
    const r = validateManifestV2(
      makeManifest({ settings: 7 as unknown as SettingsSchema }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings must be a plain object");
  });
});

describe("validateSettingsSchema — bad keys", () => {
  test.each([
    ["Foo", "uppercase letter"],
    ["1bar", "leading digit"],
    ["_x", "leading underscore"],
    ["a..b", "double dot"],
    ["a".repeat(65), "longer than 64 chars"],
    ["bad-dash", "hyphen disallowed"],
    ["", "empty"],
  ])("rejects key %p (%s)", (key) => {
    const settings = { [key]: { type: "boolean", label: "X" } as SettingsField };
    const r = validateManifestV2(
      makeManifest({ settings: settings as SettingsSchema }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes(`settings key "${key}"`)),
    ).toBe(true);
  });
});

describe("validateSettingsSchema — field-level type/label", () => {
  test("rejects non-object field", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: { v: 42 as unknown as SettingsField },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v must be an object");
  });

  test("rejects null field", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: { v: null as unknown as SettingsField },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v must be an object");
  });

  test("rejects array field", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: { v: [] as unknown as SettingsField },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v must be an object");
  });

  test("rejects unknown field type", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "color",
            label: "Color",
          } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes('settings.v.type must be one of "select"|"text"|"number"|"boolean"'),
      ),
    ).toBe(true);
  });

  test("rejects missing label", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "boolean" } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes("settings.v.label is required")),
    ).toBe(true);
  });

  test("rejects empty label", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "boolean", label: "" } as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes("settings.v.label is required")),
    ).toBe(true);
  });

  test("rejects non-string description", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "boolean",
            label: "V",
            description: 42 as unknown as string,
          } as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.description must be a string");
  });
});

describe("validateSettingsSchema — select", () => {
  test("rejects missing options", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "select", label: "V" } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.options must be a non-empty array");
  });

  test("rejects empty options array", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "select", label: "V", options: [] },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.options must be a non-empty array");
  });

  test("rejects duplicate option values", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "select",
            label: "V",
            options: [
              { value: "x", label: "X" },
              { value: "x", label: "X2" },
            ],
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes('"x" is duplicated')),
    ).toBe(true);
  });

  test("rejects default not in options", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "select",
            label: "V",
            options: [{ value: "a", label: "A" }],
            default: "z",
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes('settings.v.default "z" must be one of the option values'),
      ),
    ).toBe(true);
  });

  test("rejects non-string option value", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "select",
            label: "V",
            options: [{ value: 1 as unknown as string, label: "One" }],
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.options[0].value must be a string");
  });

  test("rejects non-string option label", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "select",
            label: "V",
            options: [{ value: "a", label: 9 as unknown as string }],
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.options[0].label must be a string");
  });

  test("rejects non-object option entry", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "select",
            label: "V",
            options: [null as unknown as { value: string; label: string }],
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.options[0] must be an object");
  });

  test("rejects non-string default", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "select",
            label: "V",
            options: [{ value: "a", label: "A" }],
            default: 1 as unknown as string,
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default must be a string");
  });
});

describe("validateSettingsSchema — text", () => {
  test("rejects bad regex pattern", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", pattern: "[" },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some(
        (e) => e.includes("settings.v.pattern") && e.toLowerCase().includes("regex"),
      ),
    ).toBe(true);
  });

  test("rejects non-string pattern", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", pattern: 5 as unknown as string },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.pattern must be a string");
  });

  test("rejects minLength > maxLength", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", minLength: 5, maxLength: 2 },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.minLength must be <= maxLength");
  });

  test("rejects negative minLength", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", minLength: -1 },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain(
      "settings.v.minLength must be a non-negative integer",
    );
  });

  test("rejects non-integer maxLength", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", maxLength: 1.5 },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain(
      "settings.v.maxLength must be a non-negative integer",
    );
  });

  test("rejects default failing pattern", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "text",
            label: "V",
            pattern: "^[a-z]+$",
            default: "ABC",
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default must match pattern");
  });

  test("rejects default shorter than minLength", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", minLength: 5, default: "abc" },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default length must be >= minLength");
  });

  test("rejects default longer than maxLength", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", maxLength: 2, default: "abcd" },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default length must be <= maxLength");
  });

  test("rejects non-string default", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "text", label: "V", default: 5 as unknown as string },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default must be a string");
  });
});

describe("validateSettingsSchema — number", () => {
  test("rejects min > max", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "number", label: "V", min: 5, max: 1 },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.min must be <= max");
  });

  test("rejects non-integer default when integer is true", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "number", label: "V", integer: true, default: 1.5 },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain(
      "settings.v.default must be an integer when integer is true",
    );
  });

  test("rejects default < min", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "number", label: "V", min: 10, default: 1 },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default must be >= min");
  });

  test("rejects default > max", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "number", label: "V", max: 10, default: 100 },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default must be <= max");
  });

  test("rejects non-finite default", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "number", label: "V", default: Infinity },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default must be a finite number");
  });

  test("rejects non-number step", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "number",
            label: "V",
            step: "1" as unknown as number,
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.step must be a finite number");
  });

  test("rejects non-boolean integer flag", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "number",
            label: "V",
            integer: "yes" as unknown as boolean,
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.integer must be a boolean");
  });
});

describe("validateSettingsSchema — secret", () => {
  test("secret with valid storageKey admits", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          psa_api_token: {
            type: "secret",
            label: "PSA API token",
            description: "Free token from api.psacard.com.",
            storageKey: "psa-token",
          },
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test.each([
    ["a", "single char"],
    ["psa-token", "the graded-card-scanner reference key"],
    ["0key", "leading digit"],
    ["a.b-c_d9", "dots, dashes, underscores, digits"],
    ["trailing_", "trailing underscore"],
    ["trailing-", "trailing dash"],
    [`k${"x".repeat(63)}`, "exactly 64 chars"],
  ])("accepts storageKey %p (%s)", (storageKey) => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          tok: { type: "secret", label: "Token", storageKey },
        },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("rejects missing storageKey", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          tok: { type: "secret", label: "Token" } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes("settings.tok.storageKey is required on secret fields"),
      ),
    ).toBe(true);
  });

  test.each([
    ["", "empty"],
    ["-lead", "leading dash"],
    [".lead", "leading dot"],
    ["_lead", "leading underscore"],
    ["UPPER", "uppercase"],
    ["has space", "space"],
    ["a/b", "slash"],
    // Trailing dot: storage-handler's validateKey rejects it on READ, so
    // admitting it would create a key the extension can never read back.
    ["token.", "trailing dot"],
    ["a.", "single char + trailing dot"],
    [`k${"x".repeat(64)}`, "65 chars"],
  ])("rejects storageKey %p (%s)", (storageKey) => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          tok: { type: "secret", label: "Token", storageKey },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes("settings.tok.storageKey is required on secret fields"),
      ),
    ).toBe(true);
  });

  test("rejects non-string storageKey", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          tok: {
            type: "secret",
            label: "Token",
            storageKey: 42 as unknown as string,
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes("settings.tok.storageKey is required on secret fields"),
      ),
    ).toBe(true);
  });

  test("rejects a default on secret fields (write-only, no plaintext in manifest)", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          tok: {
            type: "secret",
            label: "Token",
            storageKey: "tok",
            default: "leaked-credential",
          } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain(
      "settings.tok.default is not allowed on secret fields",
    );
  });

  test.each([
    ["text", { type: "text", label: "T" }],
    ["number", { type: "number", label: "N" }],
    ["boolean", { type: "boolean", label: "B" }],
    [
      "select",
      { type: "select", label: "S", options: [{ value: "a", label: "A" }] },
    ],
  ])("rejects storageKey on %s fields", (_kind, base) => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { ...base, storageKey: "some-key" } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain(
      "settings.v.storageKey is only allowed on secret fields",
    );
  });

  test("secret still requires a label", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          tok: { type: "secret", storageKey: "tok" } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes("settings.tok.label is required")),
    ).toBe(true);
  });

  test("unknown-type error message lists secret", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: { type: "color", label: "C" } as unknown as SettingsField,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes(
          'settings.v.type must be one of "select"|"text"|"number"|"boolean"|"secret"',
        ),
      ),
    ).toBe(true);
  });
});

describe("isValidForField — secret", () => {
  const field: SettingsField = {
    type: "secret",
    label: "Token",
    storageKey: "tok",
  };

  test("accepts a non-empty string within the cap", () => {
    expect(isValidForField(field, "abc123")).toBe(true);
  });

  test("accepts a string of exactly the max length", () => {
    expect(isValidForField(field, "x".repeat(SECRET_SETTING_MAX_LENGTH))).toBe(
      true,
    );
  });

  test("rejects the empty string", () => {
    expect(isValidForField(field, "")).toBe(false);
  });

  test("rejects a string over the max length", () => {
    expect(
      isValidForField(field, "x".repeat(SECRET_SETTING_MAX_LENGTH + 1)),
    ).toBe(false);
  });

  test.each([
    [42, "number"],
    [true, "boolean"],
    [null, "null"],
    [{ v: "x" }, "object"],
    [["x"], "array"],
    [undefined, "undefined"],
  ])("rejects non-string value %p (%s)", (value) => {
    expect(isValidForField(field, value)).toBe(false);
  });
});

describe("validateSettingsSchema — boolean", () => {
  test("rejects non-boolean default", () => {
    const r = validateManifestV2(
      makeManifest({
        settings: {
          v: {
            type: "boolean",
            label: "V",
            default: "yes" as unknown as boolean,
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("settings.v.default must be a boolean");
  });
});

describe("validateSettingsSchema — full manifest", () => {
  test("kokoro-tts-shaped manifest with settings admits cleanly", () => {
    const r = validateManifestV2(
      makeManifest({
        name: "kokoro-tts",
        settings: {
          voice: {
            type: "select",
            label: "Voice",
            description: "Speaker timbre.",
            options: [
              { value: "af_bella", label: "Bella" },
              { value: "am_adam", label: "Adam" },
            ],
            default: "af_bella",
          },
          speed: {
            type: "number",
            label: "Playback speed",
            description: "1.0 = natural; <1 slower, >1 faster.",
            min: 0.5,
            max: 2.0,
            step: 0.05,
            default: 1.0,
          },
          loop: {
            type: "boolean",
            label: "Loop",
            default: false,
          },
          handle: {
            type: "text",
            label: "Handle",
            pattern: "^[a-z0-9_]+$",
            default: "default_handle",
          },
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
