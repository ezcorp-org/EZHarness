/**
 * Unit tests for the shared test/determinism surface gate.
 *
 * The gate guards every `/api/__test/**` route. It MUST be fail-safe:
 * closed by default, and closed in production even if the opt-in flag is
 * set. These tests pin both conditions and the default-OFF posture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";

const savedE2E = process.env.PI_E2E_REAL;
const savedNodeEnv = process.env.NODE_ENV;

function setEnv(piE2eReal: string | undefined, nodeEnv: string | undefined): void {
  if (piE2eReal === undefined) delete process.env.PI_E2E_REAL;
  else process.env.PI_E2E_REAL = piE2eReal;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
}

beforeEach(() => {
  setEnv(undefined, undefined);
});

afterEach(() => {
  setEnv(savedE2E, savedNodeEnv);
});

describe("isTestSurfaceEnabled", () => {
  test("default (no flag) → closed", () => {
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("opt-in flag + non-production → open", () => {
    setEnv("1", "test");
    expect(isTestSurfaceEnabled()).toBe(true);
  });

  test("opt-in flag + NODE_ENV unset → open (dev/preview)", () => {
    setEnv("1", undefined);
    expect(isTestSurfaceEnabled()).toBe(true);
  });

  test("opt-in flag but production → CLOSED (fail-safe)", () => {
    setEnv("1", "production");
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("flag not exactly '1' → closed", () => {
    setEnv("true", "test");
    expect(isTestSurfaceEnabled()).toBe(false);
    setEnv("0", "test");
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("production with no flag → closed", () => {
    setEnv(undefined, "production");
    expect(isTestSurfaceEnabled()).toBe(false);
  });
});
