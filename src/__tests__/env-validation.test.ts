import { test, expect, beforeEach, afterEach } from "bun:test";
import { validateEnv } from "../env-validation";

const VARS = [
  "EZCORP_ENCRYPTION_SECRET",
  "EZCORP_JWT_SECRET",
  "DATABASE_URL",
  "EZCORP_OAUTH_CB_PORT",
] as const;

const originals: Partial<Record<(typeof VARS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const v of VARS) {
    originals[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (originals[v] === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = originals[v]!;
    }
  }
});

test("validateEnv passes when all vars are unset (uses defaults)", () => {
  expect(() => validateEnv()).not.toThrow();
});

test("validateEnv passes with valid configuration", () => {
  process.env.EZCORP_ENCRYPTION_SECRET = "a".repeat(32);
  process.env.EZCORP_JWT_SECRET = "b".repeat(32);
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
  process.env.EZCORP_OAUTH_CB_PORT = "1455";
  expect(() => validateEnv()).not.toThrow();
});

test("validateEnv accepts postgresql:// scheme", () => {
  process.env.DATABASE_URL = "postgresql://user@host/db";
  expect(() => validateEnv()).not.toThrow();
});

test("validateEnv throws actionable error on malformed DATABASE_URL", () => {
  process.env.DATABASE_URL = "mysql://wrong";
  expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  expect(() => validateEnv()).toThrow(/postgres/);
});

test("validateEnv throws on short EZCORP_ENCRYPTION_SECRET", () => {
  process.env.EZCORP_ENCRYPTION_SECRET = "tooshort";
  expect(() => validateEnv()).toThrow(/EZCORP_ENCRYPTION_SECRET/);
  expect(() => validateEnv()).toThrow(/at least 16/);
});

test("validateEnv throws on short EZCORP_JWT_SECRET", () => {
  process.env.EZCORP_JWT_SECRET = "short";
  expect(() => validateEnv()).toThrow(/EZCORP_JWT_SECRET/);
  expect(() => validateEnv()).toThrow(/at least 16/);
});

test("validateEnv throws on non-numeric EZCORP_OAUTH_CB_PORT", () => {
  process.env.EZCORP_OAUTH_CB_PORT = "abc";
  expect(() => validateEnv()).toThrow(/EZCORP_OAUTH_CB_PORT/);
  expect(() => validateEnv()).toThrow(/valid port/);
});

test("validateEnv throws on out-of-range EZCORP_OAUTH_CB_PORT", () => {
  process.env.EZCORP_OAUTH_CB_PORT = "70000";
  expect(() => validateEnv()).toThrow(/EZCORP_OAUTH_CB_PORT/);
});

test("validateEnv throws on zero EZCORP_OAUTH_CB_PORT", () => {
  process.env.EZCORP_OAUTH_CB_PORT = "0";
  expect(() => validateEnv()).toThrow(/EZCORP_OAUTH_CB_PORT/);
});

test("validateEnv accepts boundary ports 1 and 65535", () => {
  process.env.EZCORP_OAUTH_CB_PORT = "1";
  expect(() => validateEnv()).not.toThrow();
  process.env.EZCORP_OAUTH_CB_PORT = "65535";
  expect(() => validateEnv()).not.toThrow();
});

test("validateEnv accepts secret at exactly minimum length", () => {
  process.env.EZCORP_ENCRYPTION_SECRET = "a".repeat(16);
  process.env.EZCORP_JWT_SECRET = "b".repeat(16);
  expect(() => validateEnv()).not.toThrow();
});
