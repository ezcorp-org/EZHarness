import { expect, test } from "bun:test";
import { parseFactoryHostAttemptHandle } from "./host-launch-client";

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
