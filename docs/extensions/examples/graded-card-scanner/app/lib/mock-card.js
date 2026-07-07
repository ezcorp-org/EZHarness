// @ts-check
// Mock mode — the hardcoded sample card the app uses when the lookup
// backend is unreachable, so the full scan → list → detail → chart flow
// works with zero network. Prices for grades 7–10 mirror real
// PriceCharting values captured 2026-07-06; the rest are plausible
// mock figures. Everything is stamped source:"mock" so the UI can say so.

/** @typedef {import("./format.js").CardRecord} CardRecord */

/**
 * Build the sample record. The scanned cert is substituted in so the
 * saved list still keys correctly; identity/grades are the fixture.
 * @param {string} cert
 * @param {string} [nowIso] fetchedAt stamp (injectable for tests)
 * @returns {CardRecord}
 */
export function mockCard(cert, nowIso) {
  const fetchedAt = nowIso ?? new Date().toISOString();
  /** @type {import("./format.js").SourceStamp} */
  const stamp = { source: "mock", fetchedAt };
  return {
    cert,
    identity: {
      subject: "Charizard",
      year: "1999",
      set: "Pokemon Base Set",
      cardNo: "4",
      variety: "Holo",
      grade: "PSA 9",
    },
    grades: [
      { grade: "PSA 1", pop: 62, price: 180.0 },
      { grade: "PSA 2", pop: 78, price: 250.0 },
      { grade: "PSA 3", pop: 152, price: 340.0 },
      { grade: "PSA 4", pop: 289, price: 425.0 },
      { grade: "PSA 5", pop: 512, price: 520.0 },
      { grade: "PSA 6", pop: 918, price: 610.0 },
      { grade: "PSA 7", pop: 1554, price: 714.5 },
      { grade: "PSA 8", pop: 2618, price: 1201.99 },
      { grade: "PSA 9", pop: 2101, price: 2587.5 },
      { grade: "PSA 10", pop: 121, price: 30100.0 },
    ],
    sources: { identity: stamp, pop: stamp, price: stamp },
  };
}
