/**
 * Event-name parity guard: `RUNTIME_EVENT_NAMES` in `src/types.ts` mirrors
 * the app's canonical list at `web/src/lib/runtime-event-names.ts`. The
 * package can't import the app's source (it ships standalone), so this
 * assertion keeps the two in lockstep — it FAILS the moment the app adds a
 * name this package doesn't have yet. See `@ezcorp/harness-client`'s
 * `src/index.test.ts` ("event-name parity with the app") for the sibling
 * copy of this guard.
 */
import { describe, expect, test } from "bun:test";
import { RUNTIME_EVENT_NAMES } from "../../../../../packages/@ezcorp/ai-kit/src/types";
// The app's canonical list — must stay identical to the package's copy.
import { RUNTIME_EVENT_NAMES as APP_EVENT_NAMES } from "../../../../../web/src/lib/runtime-event-names";

describe("event-name parity with the app", () => {
  test("package list === app list (no drift)", () => {
    expect([...RUNTIME_EVENT_NAMES]).toEqual([...APP_EVENT_NAMES]);
  });
});
