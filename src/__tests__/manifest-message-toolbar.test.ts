/**
 * Validator coverage for the `messageToolbar` extension point and the
 * paired `permissions.appendMessages` permission.
 *
 * Mirrors the style of `ext-pure-functions.test.ts` — drives the public
 * `validateManifestV2` API with crafted manifests and asserts both the
 * `valid` flag and the error strings users will see.
 */

import { test, expect, describe } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";
import type {
  ExtensionManifestV2,
  MessageToolbarItem,
} from "../extensions/types";

function makeManifest(extra: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
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

const validItem = (overrides: Partial<MessageToolbarItem> = {}): MessageToolbarItem => ({
  id: "speak",
  icon: "Volume2",
  tooltip: "Read aloud",
  appliesTo: "both",
  event: "ext-name:speak",
  ...overrides,
});

describe("validateMessageToolbarArray", () => {
  test("accepts a valid item that is also in eventSubscriptions", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem()],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("accepts when appliesTo is omitted", () => {
    const item = validItem();
    delete (item as Partial<MessageToolbarItem>).appliesTo;
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [item],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("rejects messageToolbar as a non-array", () => {
    const r = validateManifestV2(
      makeManifest({ messageToolbar: "nope" as unknown as MessageToolbarItem[] }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("messageToolbar must be an array");
  });

  test("rejects an item that is not an object", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [42 as unknown as MessageToolbarItem],
        permissions: { eventSubscriptions: [] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("messageToolbar[0] must be an object"))).toBe(true);
  });

  test("rejects bad id charset", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem({ id: "BAD ID!" })],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("messageToolbar[0].id must match"))).toBe(true);
  });

  test("rejects duplicate ids within the same extension", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [
          validItem({ id: "speak", event: "ext-name:speak" }),
          validItem({ id: "speak", event: "ext-name:speak2" }),
        ],
        permissions: {
          eventSubscriptions: ["ext-name:speak", "ext-name:speak2"],
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes('id "speak" is duplicated')),
    ).toBe(true);
  });

  test("rejects missing icon", () => {
    const item = validItem();
    delete (item as Partial<MessageToolbarItem>).icon;
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [item],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("messageToolbar[0].icon"))).toBe(true);
  });

  test("rejects non-string tooltip", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem({ tooltip: 9 as unknown as string })],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("messageToolbar[0].tooltip"))).toBe(true);
  });

  test("rejects unknown appliesTo", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [
          validItem({ appliesTo: "system" as unknown as MessageToolbarItem["appliesTo"] }),
        ],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes("messageToolbar[0].appliesTo")),
    ).toBe(true);
  });

  test("rejects event without manifest-name prefix", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem({ event: "other-ext:speak" })],
        permissions: { eventSubscriptions: ["other-ext:speak"] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes('must be prefixed with "ext-name:"')),
    ).toBe(true);
  });

  test("rejects event missing from eventSubscriptions allowlist", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem()],
        permissions: { eventSubscriptions: [] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes("must also be listed in permissions.eventSubscriptions"),
      ),
    ).toBe(true);
  });

  test("accepts appliesToSelection: 'single'", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem({ appliesToSelection: "single" })],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("accepts appliesToSelection: 'bulk'", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem({ appliesToSelection: "bulk" })],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("accepts appliesToSelection: 'both'", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem({ appliesToSelection: "both" })],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("accepts appliesToSelection omitted (defaults to 'single' downstream)", () => {
    // appliesToSelection is optional; the validator must not require it.
    const item = { ...validItem() };
    delete (item as Partial<MessageToolbarItem>).appliesToSelection;
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [item],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("rejects appliesToSelection that's not single|bulk|both", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [
          validItem({
            appliesToSelection: "wrong" as unknown as "single",
          }),
        ],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes(`messageToolbar[0].appliesToSelection must be one of "single"|"bulk"|"both"`),
      ),
    ).toBe(true);
  });

  test("rejects appliesToSelection that's not a string", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [
          validItem({
            appliesToSelection: 1 as unknown as "single",
          }),
        ],
        permissions: { eventSubscriptions: ["ext-name:speak"] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes(`messageToolbar[0].appliesToSelection must be one of "single"|"bulk"|"both"`),
      ),
    ).toBe(true);
  });

  test("rejects empty event string", () => {
    const r = validateManifestV2(
      makeManifest({
        messageToolbar: [validItem({ event: "" })],
        permissions: { eventSubscriptions: [""] },
      }),
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes("messageToolbar[0].event is required and must be a string"),
      ),
    ).toBe(true);
  });
});

describe("permissions.appendMessages validator", () => {
  test("accepts excludedDefault: true", () => {
    const r = validateManifestV2(
      makeManifest({
        permissions: { appendMessages: { excludedDefault: true } },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("accepts excludedDefault: false", () => {
    const r = validateManifestV2(
      makeManifest({
        permissions: { appendMessages: { excludedDefault: false } },
      }),
    );
    expect(r.valid).toBe(true);
  });

  test("rejects appendMessages as a non-object", () => {
    const r = validateManifestV2(
      makeManifest({
        permissions: {
          appendMessages: true as unknown as { excludedDefault: boolean },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("permissions.appendMessages must be an object");
  });

  test("rejects appendMessages as an array", () => {
    const r = validateManifestV2(
      makeManifest({
        permissions: {
          appendMessages: [] as unknown as { excludedDefault: boolean },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("permissions.appendMessages must be an object");
  });

  test("rejects missing excludedDefault", () => {
    const r = validateManifestV2(
      makeManifest({
        permissions: {
          appendMessages: {} as unknown as { excludedDefault: boolean },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain(
      "permissions.appendMessages.excludedDefault must be a boolean",
    );
  });

  test("rejects non-boolean excludedDefault", () => {
    const r = validateManifestV2(
      makeManifest({
        permissions: {
          appendMessages: {
            excludedDefault: "yes" as unknown as boolean,
          },
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toContain(
      "permissions.appendMessages.excludedDefault must be a boolean",
    );
  });
});

describe("messageToolbar + appendMessages combined", () => {
  test("kokoro-tts shape (the bundled-extension manifest) validates clean", () => {
    const r = validateManifestV2(
      makeManifest({
        name: "kokoro-tts",
        messageToolbar: [
          {
            id: "speak",
            icon: "Volume2",
            tooltip: "Read aloud (selection or full message)",
            appliesTo: "both",
            event: "kokoro-tts:speak",
          },
        ],
        permissions: {
          eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
          appendMessages: { excludedDefault: true },
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
