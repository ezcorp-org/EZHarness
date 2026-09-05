import { expect, test } from "bun:test";
import { deferredModuleFunctions, deferredWorkflowAccess } from "./helpers/mock-cleanup";

test("deferred module cleanup loads only on call and forwards exact arguments and results", async () => {
  let loads = 0;
  const input = { value: 7 };
  const output = { accepted: true };
  const failure = new Error("original failure");
  const calls: unknown[][] = [];
  const source = {
    sync: (...args: unknown[]) => { calls.push(args); return output; },
    async: async (...args: unknown[]) => { calls.push(args); return output; },
    throws: () => { throw failure; },
  };
  const deferred = deferredModuleFunctions(() => { loads++; return source; }, { sync: true, async: true, throws: true });
  expect(loads).toBe(0);
  expect(Object.keys(deferred)).toEqual(Object.keys(source));
  expect(deferred.sync(input, 4)).toBe(output);
  expect(await deferred.async(input)).toBe(output);
  expect(calls).toEqual([[input, 4], [input]]);
  expect(() => deferred.throws()).toThrow(failure);
  expect(loads).toBe(3);
  source.sync = () => ({ accepted: false });
  expect(deferred.sync()).toEqual({ accepted: false });
  expect(loads).toBe(4);
  const rejected = Promise.reject(failure);
  source.async = () => rejected;
  const forwarded = deferred.async();
  expect(forwarded).toBe(rejected);
  await expect(forwarded).rejects.toBe(failure);
  expect(loads).toBe(5);
});

test("deferred cleanup rejects a runtime module whose function export disappeared", () => {
  const deferred = deferredModuleFunctions(() => ({ run: null }) as unknown as { run(): void }, { run: true });
  expect(() => deferred.run()).toThrow("Expected module function run");
});

test("workflow access cleanup exposes its complete function surface without loading it", () => {
  expect(Object.keys(deferredWorkflowAccess()).sort()).toEqual([
    "callerFor", "denyVisibilityOr", "listVisibleWorkflows", "resolveDelegationConsentOr",
    "resolveWorkflowOr", "toWire", "validateWorkflowForCaller",
  ]);
});
