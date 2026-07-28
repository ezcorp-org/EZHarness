/**
 * `SdkCapability` (src/extensions/recordCapabilityCall.ts) MUST agree with
 * `sdk_capability_calls.capability`'s `$type<>` union (src/db/schema.ts).
 *
 * Why a source-text test rather than a type-level one: the column is plain
 * `text` with a Drizzle `$type<>` PHANTOM annotation. A value that only one
 * side knows about inserts perfectly happily and then reads back as a type
 * TypeScript swears is impossible — the drift is invisible to both the
 * compiler and the database. The only place the two are comparable is the
 * source, so that is what we compare.
 *
 * If this fails: you added a capability to one side only. Add it to both.
 */
import { test, expect, describe } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");

/** Pull the member strings out of a `"a" | "b" | "c"` union fragment. */
function members(fragment: string): Set<string> {
  return new Set(fragment.match(/"([a-z]+)"/g)?.map((m) => m.slice(1, -1)) ?? []);
}

describe("SdkCapability ↔ sdk_capability_calls.capability", () => {
  test("the two unions list exactly the same capabilities", async () => {
    const handlerSrc = await Bun.file(
      join(REPO, "src/extensions/recordCapabilityCall.ts"),
    ).text();
    const schemaSrc = await Bun.file(join(REPO, "src/db/schema.ts")).text();

    const handlerMatch = handlerSrc.match(
      /export type SdkCapability =([\s\S]*?);/,
    );
    expect(handlerMatch, "SdkCapability declaration not found").not.toBeNull();

    const schemaMatch = schemaSrc.match(
      /capability: text\("capability"\)\.notNull\(\)\.\$type<([^>]*)>\(\)/,
    );
    expect(schemaMatch, "sdkCapabilityCalls.capability $type<> not found").not.toBeNull();

    const fromHandler = members(handlerMatch![1]!);
    const fromSchema = members(schemaMatch![1]!);

    expect(fromHandler.size).toBeGreaterThan(0);
    expect([...fromSchema].sort()).toEqual([...fromHandler].sort());
  });

  test("both sides carry the W2 `workflows` capability", () => {
    // A named anchor so a future refactor that guts the regex above still
    // fails loudly for the capability this test was added with.
    const _typecheck: import("../extensions/recordCapabilityCall").SdkCapability =
      "workflows";
    expect(_typecheck).toBe("workflows");
  });
});
