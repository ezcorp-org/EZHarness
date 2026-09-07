import { describe, expect, test } from "bun:test";
import { resourceRunConfig } from "./lib/shipping-runtime-resource-config";

describe("R4 resource run configuration", () => {
  test("keeps the normal ten-cycle suite unchanged", () => {
    expect(resourceRunConfig({})).toEqual({ mode: "cycles", maximumCycles: 10 });
    expect(resourceRunConfig({ EZ_RUNTIME_RESOURCE_CYCLES: "20" })).toEqual({ mode: "cycles", maximumCycles: 20 });
  });

  test("requires an explicit bounded duration soak and cycle ceiling", () => {
    expect(resourceRunConfig({ EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS: "1800" })).toEqual({ mode: "duration", requestedMinimumDurationMs: 1_800_000, maximumCycles: 1440 });
    expect(resourceRunConfig({ EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS: "86400", EZ_RUNTIME_RESOURCE_MAX_CYCLES: "5000" })).toEqual({ mode: "duration", requestedMinimumDurationMs: 86_400_000, maximumCycles: 5000 });
    expect(() => resourceRunConfig({ EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS: "1799" })).toThrow("EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS");
    expect(() => resourceRunConfig({ EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS: "86401" })).toThrow("EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS");
    expect(() => resourceRunConfig({ EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS: "1800", EZ_RUNTIME_RESOURCE_MAX_CYCLES: "5001" })).toThrow("EZ_RUNTIME_RESOURCE_MAX_CYCLES");
  });

  test("does not silently combine bounded-cycle and duration modes", () => {
    expect(() => resourceRunConfig({ EZ_RUNTIME_RESOURCE_CYCLES: "10", EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS: "1800" })).toThrow("cannot be combined");
    expect(() => resourceRunConfig({ EZ_RUNTIME_RESOURCE_MAX_CYCLES: "30" })).toThrow("requires EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS");
  });
});
