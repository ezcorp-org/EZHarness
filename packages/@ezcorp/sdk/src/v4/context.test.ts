import { expect, test } from "bun:test";
import { getInvocationSignal, withExtensionContext } from "./context";

test("cancellation signal is invocation-scoped and absent outside invocation", async () => {
  expect(getInvocationSignal()).toBeUndefined();
  const controllers = [new AbortController(), new AbortController()];
  await Promise.all(controllers.map((controller, index) => withExtensionContext({
    signal: controller.signal,
    invocation: { invocationId: `invocation-${index}`, workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "test", deadline: Date.now() + 1000 },
    call: async () => { throw new Error("No host calls"); },
  }, async () => {
    await Promise.resolve();
    expect(getInvocationSignal()).toBe(controller.signal);
    controller.abort();
    expect(getInvocationSignal()?.aborted).toBe(true);
  })));
  expect(getInvocationSignal()).toBeUndefined();
});
