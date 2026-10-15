import { describe, expect, it } from "bun:test";
import {
  FACTORY_GATEWAY_ACTIVITY_TIMEOUT_MS,
  FACTORY_GATEWAY_REQUEST_TIMEOUT_MAX_MS,
  FACTORY_GATEWAY_REQUEST_TIMEOUT_MS,
} from "../../packages/@ezcorp/factory-orchestrator/src/contracts.ts";
import { FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS } from "../factory/private-service-composition";
import { FACTORY_PHYSICAL_STOP_TIMEOUT_MS } from "../factory/task-stops";

/**
 * W01h: the orchestrator's gateway client (30 s) and Temporal's start-to-close
 * (30 s) were shorter than the private service's 40 s bound for a slow stop, so
 * a stop the service was still serving was cut and sent again up to three times.
 * The order below is the invariant; a change that inverts any step fails here.
 */
describe("factory gateway timeout order", () => {
  const margin = FACTORY_PHYSICAL_STOP_TIMEOUT_MS / 4;

  it("keeps the client above the private service's bound by a margin", () => {
    expect(FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS + margin).toBeLessThanOrEqual(FACTORY_GATEWAY_REQUEST_TIMEOUT_MS);
  });

  it("keeps every configurable client bound below one activity's start-to-close bound", () => {
    expect(FACTORY_GATEWAY_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(FACTORY_GATEWAY_REQUEST_TIMEOUT_MAX_MS);
    expect(FACTORY_GATEWAY_REQUEST_TIMEOUT_MAX_MS + margin).toBeLessThanOrEqual(FACTORY_GATEWAY_ACTIVITY_TIMEOUT_MS);
  });

  it("pins the measured values", () => {
    expect([FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS, FACTORY_GATEWAY_REQUEST_TIMEOUT_MS, FACTORY_GATEWAY_REQUEST_TIMEOUT_MAX_MS, FACTORY_GATEWAY_ACTIVITY_TIMEOUT_MS])
      .toEqual([40_000, 50_000, 60_000, 90_000]);
  });
});
