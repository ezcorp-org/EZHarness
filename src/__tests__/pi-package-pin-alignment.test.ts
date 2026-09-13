/**
 * Pin-alignment guard for the three `@earendil-works/pi-*` packages.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `pi-agent-core@0.84.4` declares `"@earendil-works/pi-ai": "^0.84.4"` and
 * `"@earendil-works/pi-telemetry": "^0.84.4"`. A version skew across the three
 * therefore does not error — it RESOLVES, by nesting a second copy of `pi-ai`
 * under `pi-agent-core` beside the root one. Two copies are two
 * identical-looking type graphs: an `AgentTool` built against one is not
 * assignable to the other, and the breakage surfaces as a type error far from
 * the bump that caused it. #247 had to repair exactly that.
 *
 * The defence is the root `overrides` block, which pins `pi-ai` and
 * `pi-telemetry` EXACTLY so every consumer in the tree collapses onto one copy.
 * That block is hand-maintained (added across #245 and #247) and nothing kept
 * it in sync with the `dependencies` pins beside it.
 *
 * Which is how #255 arrived INERT: dependabot rewrote
 * `dependencies["@earendil-works/pi-ai"]` to 0.84.4 and left
 * `overrides["@earendil-works/pi-ai"]` at 0.84.3, so the override won and
 * `bun.lock` still resolved `@earendil-works/pi-ai@0.84.3`. The declared range
 * moved; the installed version did not. Every check stayed green, because
 * nothing was broken — nothing had changed. That is the failure mode with no
 * symptom, and it is the one this file exists to give a symptom to.
 *
 * `.github/dependabot.yml` excludes `pi-ai` and `pi-agent-core` from the
 * grouped bun PR because they "must move as a pair". These assertions are what
 * make that comment enforceable.
 *
 * WHEN THIS FAILS, the fix is to edit the pins so all four agree and re-run
 * `bun install` — never to relax the assertion. A caret in `overrides` would
 * silently re-admit the second copy this file exists to prevent.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getProjectRoot } from "../extensions/project-root";

/** The exact-pin sites in the root `package.json`, as `section.package`. */
const PIN_SITES = [
  ["overrides", "@earendil-works/pi-ai"],
  ["overrides", "@earendil-works/pi-telemetry"],
  ["dependencies", "@earendil-works/pi-ai"],
  ["dependencies", "@earendil-works/pi-agent-core"],
] as const;

/** Every package `bun.lock` must resolve to exactly one version. */
const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-telemetry",
] as const;

/** An exact pin — no `^`, no `~`, no range. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const root = getProjectRoot();

/** Every pin site keyed as `section.package`, with whatever is on disk. */
async function readPins(): Promise<Record<string, unknown>> {
  const pkg = (await Bun.file(join(root, "package.json")).json()) as Record<
    string,
    Record<string, string> | undefined
  >;
  return Object.fromEntries(
    PIN_SITES.map(([section, name]) => [`${section}.${name}`, pkg[section]?.[name]]),
  );
}

/**
 * The pin every other site must match: the `dependencies` entry for `pi-ai`,
 * the one dependabot actually rewrites. Anchoring on it makes a failure read
 * as "the other three did not follow" rather than an arbitrary diff.
 *
 * Throws rather than returning `undefined` so the tests below can use a plain
 * `string`. "package.json lost this key" is not a case any of them should have
 * to spell out a branch for, and the throw fails the test just as loudly.
 */
function anchorPin(pins: Record<string, unknown>): string {
  const anchor = pins["dependencies.@earendil-works/pi-ai"];
  if (typeof anchor !== "string") {
    throw new Error(
      `dependencies['@earendil-works/pi-ai'] is missing from package.json (got ${JSON.stringify(anchor)})`,
    );
  }
  return anchor;
}

/**
 * Every distinct version `lockText` resolves for `name`, sorted.
 *
 * Scans the raw text rather than parsing: `bun.lock` is JSONC (trailing
 * commas) and `JSON.parse` rejects it. The scan is also the STRONGER check.
 * A nested duplicate is keyed by its dependency PATH — say
 * `"@earendil-works/pi-agent-core/@earendil-works/pi-ai"` — so walking a
 * parsed `packages` map by name would look right while the duplicate sat one
 * key away. Every resolution anywhere in the file, nested or not, spells its
 * version as the `"<name>@<version>"` tuple matched here.
 *
 * Plain string search, not a regex, so a package name containing a regex
 * metacharacter can never quietly change what this matches.
 */
function resolvedVersions(lockText: string, name: string): string[] {
  const needle = `"${name}@`;
  const found = new Set<string>();
  for (let i = lockText.indexOf(needle); i !== -1; i = lockText.indexOf(needle, i + 1)) {
    const start = i + needle.length;
    const end = lockText.indexOf('"', start);
    if (end !== -1) found.add(lockText.slice(start, end));
  }
  return [...found].sort();
}

describe("@earendil-works/pi-* packages move as one", () => {
  test("every pin in package.json is the same exact version", async () => {
    const pins = await readPins();
    const anchor = anchorPin(pins);

    expect(
      anchor,
      "dependencies['@earendil-works/pi-ai'] must be an exact pin — a range in " +
        "overrides re-admits the duplicate copy this guard exists to prevent",
    ).toMatch(EXACT_VERSION);

    expect(pins).toEqual({
      "overrides.@earendil-works/pi-ai": anchor,
      "overrides.@earendil-works/pi-telemetry": anchor,
      "dependencies.@earendil-works/pi-ai": anchor,
      "dependencies.@earendil-works/pi-agent-core": anchor,
    });
  });

  test("bun.lock resolves exactly one version of each pi package", async () => {
    const lock = await Bun.file(join(root, "bun.lock")).text();
    const counts = Object.fromEntries(
      PI_PACKAGES.map((name) => [name, resolvedVersions(lock, name).length]),
    );

    // More than one means a second copy is nested under a sibling — the #247
    // duplicate type graph. Zero means the scan stopped matching the lockfile
    // format and the whole guard has gone blind, which must fail just as loudly.
    expect(counts).toEqual({
      "@earendil-works/pi-ai": 1,
      "@earendil-works/pi-agent-core": 1,
      "@earendil-works/pi-telemetry": 1,
    });
  });

  test("the version bun.lock resolves is the version package.json pins", async () => {
    const anchor = anchorPin(await readPins());
    const lock = await Bun.file(join(root, "bun.lock")).text();
    const resolved = Object.fromEntries(
      PI_PACKAGES.map((name) => [name, resolvedVersions(lock, name)]),
    );

    // A mismatch here is the inert-bump signature: package.json says one
    // version, the installed tree is still on another. Run `bun install`.
    expect(resolved).toEqual({
      "@earendil-works/pi-ai": [anchor],
      "@earendil-works/pi-agent-core": [anchor],
      "@earendil-works/pi-telemetry": [anchor],
    });
  });
});
