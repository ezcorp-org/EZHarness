/**
 * Lockstep guard: the pollen bands the `city-conditions` extension can
 * EMIT must be exactly the bands its chat card knows how to LABEL.
 *
 * The two definitions cannot import each other. The card is client code,
 * and pulling `docs/extensions/examples/**` into the browser bundle is
 * the same boundary violation `card-type-parity.test.ts` exists to work
 * around — so, like that one, this test is the pairing.
 *
 * The card deliberately does NOT re-derive a band from `totalIndex`; the
 * host computes it and the card only maps it to a label. That is the
 * right split, and it is also precisely why drift here is silent: add a
 * band host-side without teaching the card and every reading in that band
 * renders as the `unknown` fallback. Safe (never blank) but wrong, and
 * nothing would fail — a pollen figure quietly mislabelled is the same
 * "execution succeeded, presentation lied" class the card's honest
 * missing-data states were written to prevent.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_BANDS_PATH = join(
	import.meta.dir,
	"../../../docs/extensions/examples/city-conditions/lib/pollen-bands.ts",
);
const CARD_LOGIC_PATH = join(
	import.meta.dir,
	"../lib/components/tool-cards/city-conditions-card-logic.ts",
);

/** Parse a `type X = "a" | "b" | ...;` union into its string members. */
function unionMembers(src: string, typeName: string): string[] {
	const marker = `export type ${typeName} =`;
	const start = src.indexOf(marker);
	expect(start, `${typeName} not found — did the declaration get renamed?`).toBeGreaterThan(-1);
	const end = src.indexOf(";", start);
	expect(end).toBeGreaterThan(start);
	const body = src.slice(start + marker.length, end);
	return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
}

describe("pollen band parity — extension ↔ card", () => {
	test("every band the extension emits is one the card can label", () => {
		const emitted = unionMembers(readFileSync(EXT_BANDS_PATH, "utf8"), "PollenBand");
		const known = unionMembers(readFileSync(CARD_LOGIC_PATH, "utf8"), "PollenBandId");

		// `unknown` wears two hats and must exist on the card either way: it
		// is the card's fallback slot for a band string it does not
		// recognise, AND (since the station provider landed) a band the
		// extension genuinely emits when a source reports no category data.
		// The two roles agree on the rendered label, so the sets match
		// exactly rather than the card carrying a spare member.
		expect(known).toContain("unknown");

		expect(
			known,
			`the card labels ${JSON.stringify(known)} but the extension emits ` +
				`${JSON.stringify(emitted)} — teach ` +
				`web/src/lib/components/tool-cards/city-conditions-card-logic.ts about the ` +
				`new band (or stop emitting it), otherwise those readings render as "unknown"`,
		).toEqual(emitted);
	});

	test("the extension's documented thresholds are the ones it implements", () => {
		const src = readFileSync(EXT_BANDS_PATH, "utf8");
		// Pinned by the contract: null → none | <1 → low | <20 → moderate |
		// <100 → high | else very-high. Reading the branch bodies keeps the
		// header comment honest against the code beneath it.
		expect(src).toContain('if (totalIndex === null) return "none"');
		expect(src).toContain('if (totalIndex < 1) return "low"');
		expect(src).toContain('if (totalIndex < 20) return "moderate"');
		expect(src).toContain('if (totalIndex < 100) return "high"');
		expect(src).toContain('return "very-high"');
	});
});
