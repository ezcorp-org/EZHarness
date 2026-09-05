import { ContractError } from "./json";

export const MAX_RUNTIME_LOCK_KEYS = 8;

export function validateRuntimeLockKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(value)) throw new ContractError("INVALID_LOCK", "Lock keys require 1-128 stable letters, digits or . _ : / - characters");
  return value;
}

export function validateRuntimeLockRequest(method: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ContractError("INVALID_LOCK", "Invalid lock request");
  const request = input as Record<string, unknown>;
  const key = validateRuntimeLockKey(request.key);
  if (method !== "ezcorp/lock.acquire" && method !== "ezcorp/lock.release" || Object.keys(request).some(name => name !== "key" && name !== "fence") || method === "ezcorp/lock.acquire" && Object.hasOwn(request, "fence") || method === "ezcorp/lock.release" && (typeof request.fence !== "string" || !request.fence || request.fence.length > 128)) throw new ContractError("INVALID_LOCK", "Invalid lock request");
  return key;
}
