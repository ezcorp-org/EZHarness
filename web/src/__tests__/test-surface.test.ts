/**
 * Unit tests for the shared test/determinism surface gate.
 *
 * The gate guards every `/api/__test/**` route. It MUST be fail-CLOSED:
 * closed by default, closed unless an operator consciously opts in with
 * `EZCORP_ALLOW_TEST_SURFACE=1`, and closed in production even if every
 * opt-in flag is set. These tests pin all three conditions and the
 * default-OFF posture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";

const savedE2E = process.env.PI_E2E_REAL;
const savedNodeEnv = process.env.NODE_ENV;
const savedAllow = process.env.EZCORP_ALLOW_TEST_SURFACE;

function setEnv(
  piE2eReal: string | undefined,
  nodeEnv: string | undefined,
  allow: string | undefined,
): void {
  if (piE2eReal === undefined) delete process.env.PI_E2E_REAL;
  else process.env.PI_E2E_REAL = piE2eReal;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (allow === undefined) delete process.env.EZCORP_ALLOW_TEST_SURFACE;
  else process.env.EZCORP_ALLOW_TEST_SURFACE = allow;
}

beforeEach(() => {
  setEnv(undefined, undefined, undefined);
});

afterEach(() => {
  setEnv(savedE2E, savedNodeEnv, savedAllow);
});

describe("isTestSurfaceEnabled", () => {
  test("default (no flag) → closed", () => {
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("all three opt-ins + non-production → open", () => {
    setEnv("1", "test", "1");
    expect(isTestSurfaceEnabled()).toBe(true);
  });

  test("all three opt-ins + NODE_ENV unset → open (dev/preview)", () => {
    setEnv("1", undefined, "1");
    expect(isTestSurfaceEnabled()).toBe(true);
  });

  test("PI_E2E_REAL=1 + dev but EZCORP_ALLOW_TEST_SURFACE unset → CLOSED (fail-closed default)", () => {
    setEnv("1", "development", undefined);
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("PI_E2E_REAL=1 + NODE_ENV unset but allow-flag unset → CLOSED (the public-staging footgun)", () => {
    setEnv("1", undefined, undefined);
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("EZCORP_ALLOW_TEST_SURFACE=1 alone (no PI_E2E_REAL) → closed", () => {
    setEnv(undefined, "test", "1");
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("all opt-ins but production → CLOSED (belt-and-braces)", () => {
    setEnv("1", "production", "1");
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("PI_E2E_REAL not exactly '1' → closed", () => {
    setEnv("true", "test", "1");
    expect(isTestSurfaceEnabled()).toBe(false);
    setEnv("0", "test", "1");
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("EZCORP_ALLOW_TEST_SURFACE not exactly '1' → closed", () => {
    setEnv("1", "test", "true");
    expect(isTestSurfaceEnabled()).toBe(false);
    setEnv("1", "test", "0");
    expect(isTestSurfaceEnabled()).toBe(false);
  });

  test("production with no flag → closed", () => {
    setEnv(undefined, "production", undefined);
    expect(isTestSurfaceEnabled()).toBe(false);
  });
});
