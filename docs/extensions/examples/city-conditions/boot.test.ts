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
