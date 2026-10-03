import { expect, test } from "bun:test";
import { GatewayStatusError } from "@ezcorp/factory-transport";
import { FACTORY_HOST_CLIENT_TIMEOUT_MS, FactoryHostLaunchRefusal, parseFactoryHostAttemptHandle } from "./host-launch-client";
import { FACTORY_HOST_LAUNCH_TIMEOUT_MS, FACTORY_HOST_RESULT_WINDOW_MS } from "./runner/host-launch-service";

test("a well-formed handle is accepted exactly as the host sent it", () => {
  expect(parseFactoryHostAttemptHandle({ disposition: "started", workerId: "worker", invocationId: "invocation" }))
    .toEqual({ disposition: "started", workerId: "worker", invocationId: "invocation" });
  for (const disposition of ["attached", "terminal", "uncertain"] as const) {
    expect(parseFactoryHostAttemptHandle({ disposition, workerId: "w", invocationId: "i" }).disposition).toBe(disposition);
  }
});

test("a reply that is not a launch outcome is refused rather than guessed at", () => {
  // A transport fault, a truncated body, or an unknown disposition must never
  // become a disposition the caller then acts on.
  for (const reply of [null, "started", [], {}, { disposition: "running", workerId: "w", invocationId: "i" }, { disposition: "started", invocationId: "i" }, { disposition: "started", workerId: "", invocationId: "i" }, { disposition: "started", workerId: "w", invocationId: 7 }, { disposition: "started", workerId: "x".repeat(513), invocationId: "i" }]) {
    expect(() => parseFactoryHostAttemptHandle(reply)).toThrow("not a launch outcome");
  }
});

test("a host refusal carries the host's own code and detail, and stays a gateway status error", () => {
  const reply = (body: string, statusCode = 502) => new FactoryHostLaunchRefusal({ statusCode, headers: {}, body: Buffer.from(body) });
  const exited = reply(JSON.stringify({ error: "guest_exited", detail: "exited with code 137" }));
  expect(exited).toBeInstanceOf(GatewayStatusError);
  expect({ name: exited.name, message: exited.message, code: exited.code, detail: exited.detail }).toEqual({ name: "FactoryHostLaunchRefusal", message: "factory gateway returned HTTP 502", code: "guest_exited", detail: "exited with code 137" });
  // A body the host did not write as a refusal names nothing the caller could act on.
  for (const body of ["not json", "null", JSON.stringify({ error: 7, detail: ["x"] })]) {
    expect({ code: reply(body).code, detail: reply(body).detail }).toEqual({ code: "unknown", detail: "" });
  }
  // Both fields are bounded, so a hostile host cannot grow the product's log.
  const long = reply(JSON.stringify({ error: "e".repeat(500), detail: "d".repeat(5_000) }));
  expect([long.code.length, long.detail.length]).toEqual([128, 1_024]);
});

test("the product's call timeout outlasts anything the host waits for, so the host always answers first", () => {
  expect(FACTORY_HOST_CLIENT_TIMEOUT_MS).toBeGreaterThan(FACTORY_HOST_LAUNCH_TIMEOUT_MS);
  expect(FACTORY_HOST_CLIENT_TIMEOUT_MS).toBeGreaterThan(FACTORY_HOST_RESULT_WINDOW_MS);
});
