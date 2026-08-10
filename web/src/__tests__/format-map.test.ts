/**
 * `formatComponentMap` / `getFormatComponent` — the format→component lookup
 * every dynamic extension input form goes through.
 *
 * Runs under VITEST, not bun, despite the plain `.test.ts` name (registered
 * explicitly in web/vitest.config.ts and subtracted from `web_bunleg_files()`
 * in scripts/lib/test-file-sets.sh — the same arrangement relative-time.test.ts
 * and send-message.test.ts use; the basename is kept so the Gate-integrity
 * test-rename check stays satisfied).
 *
 * Two reasons it had to move:
 *   1. The module imports five `.svelte` components. Bun resolves those to an
 *      opaque non-null value, so `expect(getFormatComponent(f)).toBeTruthy()`
 *      passed without ever proving a Svelte component came back. Vitest runs
 *      the real compiler, so the assertions below can check the identity of
 *      the mapped component instead of its truthiness.
 *   2. The vitest leg is the ONLY coverage producer for `web/src/lib/**`
 *      (scripts/test-coverage.sh). On the bun leg this suite produced no lcov
 *      at all, so `format-map.ts` read as unmeasurable — which is why its four
 *      `any`s sat on `biome.json`'s noExplicitAny opt-out list (issue #142).
 */
import { describe, test, expect } from "vitest";
import { getFormatComponent, formatComponentMap } from "../lib/components/ui/format-map";
import SharedFilePicker from "../lib/components/ui/SharedFilePicker.svelte";
import ComboBox from "../lib/components/ui/ComboBox.svelte";
import SearchBox from "../lib/components/ui/SearchBox.svelte";
import TagInput from "../lib/components/ui/TagInput.svelte";
import DatePicker from "../lib/components/ui/DatePicker.svelte";

describe("formatComponentMap", () => {
  test("contains exactly 6 format keys", () => {
    const keys = Object.keys(formatComponentMap);
    expect(keys).toHaveLength(6);
    expect(keys.sort()).toEqual(
      ["combo-box", "date", "datetime", "file-path", "search", "tag-input"].sort(),
    );
  });

  test("date and datetime map to the same component", () => {
    expect(formatComponentMap["date"]).toBe(formatComponentMap["datetime"]);
  });
});

describe("getFormatComponent", () => {
  test.each([
    ["file-path", SharedFilePicker],
    ["combo-box", ComboBox],
    ["search", SearchBox],
    ["tag-input", TagInput],
    ["date", DatePicker],
    ["datetime", DatePicker],
  ])("returns the mapped component for '%s'", (format, component) => {
    expect(getFormatComponent(format as string)).toBe(component);
  });

  test("throws for unknown format with descriptive message", () => {
    expect(() => getFormatComponent("unknown-format")).toThrow(/Unrecognized input format/);
  });

  test("error message names the rejected format and lists the valid ones", () => {
    let message = "";
    try {
      getFormatComponent("unknown-format");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('"unknown-format"');
    for (const key of Object.keys(formatComponentMap)) {
      expect(message).toContain(key);
    }
  });
});
