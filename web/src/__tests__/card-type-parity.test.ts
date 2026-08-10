/**
 * Lockstep guard: the host's `KNOWN_CARD_TYPES` (which manifest
 * validation now rejects unknown values against) must name exactly the
 * card types the router actually knows.
 *
 * The two lists cannot import each other — `utils.ts` is client code and
 * pulling `src/extensions/**` into it would drag server modules into the
 * browser bundle — so this test is the pairing. Without it the
 * validation could drift into rejecting a card the UI renders (breaking
 * a legitimate install) or accepting one it does not (re-introducing the
 * exact silent-degrade-to-DefaultCard bug it was added to prevent).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_CARD_TYPES } from "../../../src/extensions/card-types";
import { getCardComponentName } from "../lib/components/tool-cards/utils.js";
import { squish } from "../../../src/__tests__/helpers/source-match";

const UTILS_PATH = join(
	import.meta.dir,
	"../lib/components/tool-cards/utils.ts",
);

/** Every `case '<x>':` literal inside `getCardComponentName`. */
function routerCardTypes(): string[] {
	// Layout- and quote-insensitive. This scan used to require
	// `default: return 'DefaultCard';` verbatim on one line with single
	// quotes; splitting or requoting the arm made `indexOf` return -1, which
	// would have yielded an EMPTY case list and a silently vacuous parity
	// check. Squishing removes layout only — the token sequence, the `case`
	// labels and their literals are all still required (see
	// src/__tests__/helpers/source-match.ts).
	const src = squish(readFileSync(UTILS_PATH, "utf8"));
	const start = src.indexOf("export function getCardComponentName");
	expect(start).toBeGreaterThan(-1);
	// The function ends at the first `default:` arm — everything after is
	// a different helper.
	const rel = src.slice(start).search(/default:\s*return ["']DefaultCard["'];/);
	expect(rel).toBeGreaterThan(-1);
	const body = src.slice(start, start + rel);
	const types = [...body.matchAll(/case ["']([^"']+)["']:/g)].map((m) => m[1] as string);
	// A reformat must never be able to empty this list without failing.
	expect(types.length).toBeGreaterThan(0);
	return types;
}

describe("cardType parity — host validation vs the router", () => {
	test("every cardType the router handles is accepted by the host", () => {
		const missing = routerCardTypes().filter((t) => !KNOWN_CARD_TYPES.has(t));
		expect(missing).toEqual([]);
	});

	test("every cardType the host accepts renders as a real (non-Default) card", () => {
		// `default` is the one deliberate exception: it is an explicit
		// opt-in to the generic card, declared by built-in tools.
		const degrades = [...KNOWN_CARD_TYPES]
			.filter((t) => t !== "default")
			.filter((t) => getCardComponentName(t, false) === "DefaultCard");
		expect(degrades).toEqual([]);
	});

	test("an unknown cardType still degrades to DefaultCard at render time", () => {
		// Belt and braces: validation rejects typos at install, but a row
		// persisted before this validation existed must not crash the UI.
		expect(KNOWN_CARD_TYPES.has("weather-pannel")).toBe(false);
		expect(getCardComponentName("weather-pannel", false)).toBe("DefaultCard");
	});

	test("the extension-author card types are both present", () => {
		expect(KNOWN_CARD_TYPES.has("ez-install")).toBe(true);
		expect(KNOWN_CARD_TYPES.has("ez-draft")).toBe(true);
		expect(getCardComponentName("ez-draft", false)).toBe("EzToolResultCard");
	});
});
