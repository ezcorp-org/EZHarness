import { expect, test } from "bun:test";
import { awaitMcpSignal } from "./cancellation";

test("MCP wait handles success, prior abort and active abort without masking operation errors", async () => {
  expect(await awaitMcpSignal(Promise.resolve(1))).toBe(1);
  const controller = new AbortController();
  expect(await awaitMcpSignal(Promise.resolve(2), controller.signal)).toBe(2);
  const pending = awaitMcpSignal(new Promise<void>(() => {}), controller.signal);
  const outcome = pending.then(() => null, error => error);
  const reason = new Error("Stopped");
  controller.abort(reason);
  expect(await outcome).toBe(reason);
  await expect(awaitMcpSignal(new Promise<void>(() => {}), controller.signal)).rejects.toBe(reason);
  await expect(awaitMcpSignal(Promise.reject(new Error("Failure")), new AbortController().signal)).rejects.toThrow("Failure");
});
