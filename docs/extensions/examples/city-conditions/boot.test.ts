// city-conditions — production boot path.
//
// `start()` only ever runs in a spawned subprocess, whose coverage is not
// collected into this process's lcov. This isolated file drives it
// IN-process against the SDK's test channel (same shape as
// webhook-ticket-loop/boot.test.ts) so the boot body is both exercised
// and asserted rather than excluded.
import { afterEach, describe, expect, test } from "bun:test";
import { __resetChannelForTests, getChannel } from "@ezcorp/sdk/runtime";
import { start, tools } from "./index";

afterEach(() => __resetChannelForTests());

describe("start (production boot)", () => {
  // NOTE: this in-process test can NOT catch a dispatch-before-channel
  // ordering bug. rpc.ts's `_register` is armed lazily by the first
  // `getChannel()` call anywhere in the process and `__resetChannelForTests`
  // deliberately does not re-arm it, so by the time this runs the register
  // is already live and a wrong order still "works". The real guard is the
  // sandboxed spawn round-trip in
  // `src/__tests__/city-conditions-extension.test.ts` ("the declared
  // smokeTest actually round-trips in a spawned sandbox"), which caught
  // exactly this: `createToolDispatcher` before `getChannel()` threw
  // "channel not ready" and killed the subprocess at spawn.
  test("mounts the dispatcher and starts the channel", () => {
    getChannel();
    expect(() => start()).not.toThrow();
    // All four tools are what the dispatcher was handed.
    expect(Object.keys(tools).sort()).toEqual([
      "air_quality",
      "city_conditions",
      "current_weather",
      "geocode",
    ]);
  });
});
