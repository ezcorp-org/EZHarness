import { expect, mock, test } from "bun:test";
const writes: unknown[] = [];
mock.module("../extensions/bundled", () => ({ getCriticalBundledExtensions: () => [{ name: "ask-user" }, { name: "task-tracking" }] }));
mock.module("../db/queries/extensions", () => ({ getExtensionByName: async (name: string) => ({ name, enabled: false, disabledByUser: name === "task-tracking", source: "local:legacy" }), updateExtension: async (...args: unknown[]) => writes.push(args) }));
const { assertCriticalExtensions } = await import("../startup/assert-critical-extensions");

test("critical extensions report approval requirements without self-approval", async () => {
  const result = await assertCriticalExtensions();
  expect(result.checked).toEqual(["ask-user", "task-tracking"]);
  expect(result.violations).toEqual(["ask-user"]);
  expect(result.userDisabled).toEqual(["task-tracking"]);
  expect(result.remediated).toEqual([]);
  expect(writes).toEqual([]);
});
