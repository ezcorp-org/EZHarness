import { expect, test } from "bun:test";
import { MAX_RUNTIME_LOCK_KEYS, validateRuntimeLockKey, validateRuntimeLockRequest } from "./locks";

test("lock vocabulary has one strict bounded contract", () => {
  expect(MAX_RUNTIME_LOCK_KEYS).toBe(8);
  for (const key of ["counter", "a".repeat(128), "A0_./:-"]) expect(validateRuntimeLockKey(key)).toBe(key);
  for (const key of [null, 1, "", "a".repeat(129), "../secret", " key", "key\n", "é"]) expect(() => validateRuntimeLockKey(key)).toThrow("Lock keys require");
  expect(validateRuntimeLockRequest("ezcorp/lock.acquire", { key: "counter" })).toBe("counter");
  expect(validateRuntimeLockRequest("ezcorp/lock.release", { key: "counter", fence: "a".repeat(128) })).toBe("counter");
  for (const input of [null, [], 1, {}, { key: "counter", extra: true }, { key: "counter", fence: undefined }]) expect(() => validateRuntimeLockRequest("ezcorp/lock.acquire", input)).toThrow();
  for (const fence of [undefined, null, 1, "", "a".repeat(129)]) expect(() => validateRuntimeLockRequest("ezcorp/lock.release", { key: "counter", fence })).toThrow();
  expect(() => validateRuntimeLockRequest("unknown", { key: "counter" })).toThrow();
});
