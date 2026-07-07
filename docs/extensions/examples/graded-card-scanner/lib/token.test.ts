// Unit tests for resolveToken — env wins, Storage fallback, else null.
// The token never appears in code; these use throwaway fixtures.

import { describe, expect, test } from "bun:test";
import { TOKEN_ENV_VAR, TOKEN_STORAGE_KEY, resolveToken, type TokenStorage } from "./token";

function storageWith(value: string | null, exists = value !== null): TokenStorage {
  return {
    async get<T = unknown>(key: string) {
      expect(key).toBe(TOKEN_STORAGE_KEY);
      return { value: value as T | null, exists };
    },
  };
}

/** A Storage whose get() must never be called (env should win first). */
function unreachableStorage(): TokenStorage {
  return {
    async get() {
      throw new Error("storage.get should not be reached when env has a token");
    },
  };
}

describe("resolveToken", () => {
  test("env token wins and is not read from storage", async () => {
    const token = await resolveToken({ [TOKEN_ENV_VAR]: "  env-token-value  " }, unreachableStorage());
    expect(token).toBe("env-token-value"); // trimmed
  });

  test("falls back to storage when env is absent", async () => {
    const token = await resolveToken({}, storageWith("stored-token-value"));
    expect(token).toBe("stored-token-value");
  });

  test("falls back to storage when env is blank / whitespace", async () => {
    const token = await resolveToken({ [TOKEN_ENV_VAR]: "   " }, storageWith("stored-token-value"));
    expect(token).toBe("stored-token-value");
  });

  test("trims the stored value", async () => {
    const token = await resolveToken({}, storageWith("  spaced-token  "));
    expect(token).toBe("spaced-token");
  });

  test("neither env nor storage → null", async () => {
    expect(await resolveToken({}, storageWith(null))).toBeNull();
  });

  test("stored key that exists but is blank → null", async () => {
    expect(await resolveToken({}, storageWith("   ", true))).toBeNull();
  });

  test("stored non-string value → null", async () => {
    const storage: TokenStorage = { async get() { return { value: 12345 as never, exists: true }; } };
    expect(await resolveToken({}, storage)).toBeNull();
  });

  test("stored key marked absent → null even if a value is present", async () => {
    expect(await resolveToken({}, storageWith("ghost", false))).toBeNull();
  });
});
