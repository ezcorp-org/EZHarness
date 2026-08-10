/**
 * The card types the chat UI can actually render.
 *
 * A tool's `cardType` was free-form `string` and validated nowhere, so
 * a typo (`"weather-pannel"`) installed cleanly and then silently fell
 * through to `DefaultCard` — a collapsed grey row instead of the panel
 * the author designed, with no error anywhere to explain it. Manifest
 * validation now rejects anything not in this set, so the typo is
 * caught at install time by the person who can fix it.
 *
 * MUST stay in lockstep with the `switch` in
 * `web/src/lib/components/tool-cards/utils.ts` (`getCardComponentName`).
 * That file is client-side and cannot import from `src/` (the `$server`
 * alias would drag server code into the browser bundle), so the pairing
 * is enforced by a parity test — `web/src/__tests__/card-type-parity.test.ts`
 * reads both and fails if either side gains a case the other lacks.
 */
export const KNOWN_CARD_TYPES: ReadonlySet<string> = new Set([
  // Explicit opt-in to the generic card. Built-in tools declare this;
  // it is a real choice, not a typo, so it stays valid.
  "default",
  "terminal",
  "diff",
  "search-results",
  "task-list",
  "task-detail",
  "ask-user-question",
  "design-canvas",
  "design-brief",
  "kokoro-tts-player",
  "price-chart",
  "grade-delta-chart",
  "substack-review",
  "weather-panel",
  "city-conditions",
  "time-clock",
  "image-gen-grid",
  "ez-install",
  "ez-draft",
  "ez-propose",
  "ez-preview-consent",
]);

/** Sorted list for error messages — stable ordering so the text a user
 *  sees does not shuffle between runs. */
export const KNOWN_CARD_TYPES_SORTED: readonly string[] = [...KNOWN_CARD_TYPES].sort();
