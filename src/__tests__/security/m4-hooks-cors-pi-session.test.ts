// Regression test for sec-M4 (fix commit 6ae0370).
//
// Two independent vulnerabilities in web/src/hooks.server.ts were fixed in
// one commit, so this file covers both:
//
// (A) CORS wildcard reflection. Pre-fix:
//       const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "")
//         .split(",").map(s => s.trim()).filter(Boolean);
//       ...
//       if (CORS_ALLOWED_ORIGINS.includes("*") ||
//           CORS_ALLOWED_ORIGINS.includes(origin)) {
//         headers["Access-Control-Allow-Origin"] = origin;
//       }
//     Because the server always echoes the caller's Origin into
//     Access-Control-Allow-Origin (required for credentialed fetches), the
//     "*" shortcut effectively reflected *any* origin and would have let
//     cross-site code read authenticated responses. Fix: strip "*" from the
//     parsed list and drop the "includes("*")" shortcut so only explicit
//     allow-list entries are honored.
//
// (B) pi_session auto-promotion with no expiry. Pre-fix, an unbounded
//     migration bridge copied any `pi_session` cookie into `ezcorp_session`
//     with a fresh 30-day max-age, with no deadline. Fix: introduces
//     PI_SESSION_MIGRATION_EXPIRES_AT (2026-06-01) and after that cutoff
//     the legacy cookie is purged instead of promoted.
//
// Because hooks.server.ts imports a tower of server-init dependencies
// (ensureInitialized, runtime, DB, extension registry, …) a direct import
// for a behavioral test is impractical. Following the sec-L3 hybrid pattern
// this file does two things:
//
//   1. Source-level assertions on web/src/hooks.server.ts — these are the
//      direct regression gate. They flip between pre-fix and post-fix.
//
//   2. Standalone functional probes that replicate the *fixed* parser and
//      header-builder and the migration-bridge decision logic, to prove the
//      fix's mechanism actually does what the source assertions claim.
//
// Tests fix(sec-M4): 6ae0370

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const HOOKS_PATH = resolve(import.meta.dir, "../../../web/src/hooks.server.ts");
const HOOKS_SRC = readFileSync(HOOKS_PATH, "utf8");

// Grab the CORS region (from the CORS_ALLOWED_ORIGINS declaration through the
// end of getCorsHeaders). A generous slice is fine — we use contains/regex.
function extractCorsBlock(src: string): string {
  const start = src.indexOf("CORS_ALLOWED_ORIGINS");
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, start + 2000);
}

// Grab the migration-bridge region (the `if (!sessionToken)` block that
// handles the legacy pi_session cookie).
function extractPiSessionBlock(src: string): string {
  const start = src.indexOf("Migration bridge");
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, start + 2000);
}

const hooksAst = ts.createSourceFile(HOOKS_PATH, HOOKS_SRC, ts.ScriptTarget.Latest, true);

/** Read the real expiry branch as syntax, so logging and indentation cannot change its meaning. */
function migrationExpiryBranches(): { expired: ts.Statement; live: ts.Statement } {
  const matches: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)) {
      const { left, operatorToken, right } = node.expression;
      if (operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
          ts.isCallExpression(left) && ts.isPropertyAccessExpression(left.expression) &&
          ts.isIdentifier(left.expression.expression) && left.expression.expression.text === "Date" &&
          left.expression.name.text === "now" && left.arguments.length === 0 &&
          ts.isIdentifier(right) && right.text === "PI_SESSION_MIGRATION_EXPIRES_AT") {
        matches.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(hooksAst);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.elseStatement).toBeDefined();
  return { expired: matches[0]!.thenStatement, live: matches[0]!.elseStatement! };
}

function callsIn(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) calls.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

function setsCookie(call: ts.CallExpression, name: string, value: string): boolean {
  return ts.isPropertyAccessExpression(call.expression) &&
    call.expression.getText(hooksAst) === "event.cookies.set" &&
    call.arguments.length >= 2 && ts.isStringLiteral(call.arguments[0]!) &&
    call.arguments[0].text === name && ts.isStringLiteral(call.arguments[1]!) &&
    call.arguments[1].text === value;
}

function assignsLegacySession(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) && node.left.text === "sessionToken" &&
      ts.isIdentifier(node.right) && node.right.text === "legacyToken") return true;
  return ts.forEachChild(node, assignsLegacySession) ?? false;
}

// ── (A) CORS source-level regression gates ──────────────────────────────
describe("sec-M4: CORS wildcard reflection is gone from hooks.server.ts source", () => {
  const corsBlock = extractCorsBlock(HOOKS_SRC);

  test("parser strips '*' from CORS_ALLOWED_ORIGINS", () => {
    // Pre-fix the filter was `.filter(Boolean)` and "*" passed through.
    // The fix must drop the literal "*" entry so it cannot be used as a
    // magic allow-everything token. A `!== "*"` token in the filter is the
    // unambiguous signal of the fix.
    expect(corsBlock).toMatch(/filter\([^)]*!==\s*"\*"/);
  });

  test("getCorsHeaders no longer short-circuits on a wildcard entry", () => {
    // Pre-fix code contained `CORS_ALLOWED_ORIGINS.includes("*")` as the
    // first branch of the allow-origin decision. Post-fix that branch is
    // removed entirely; only an exact origin match echoes ACAO.
    expect(corsBlock).not.toMatch(/CORS_ALLOWED_ORIGINS\.includes\(\s*"\*"\s*\)/);
  });

  test("getCorsHeaders requires an exact CORS_ALLOWED_ORIGINS match to echo", () => {
    // The only remaining allow branch must be an `.includes(origin)` check.
    expect(corsBlock).toMatch(/CORS_ALLOWED_ORIGINS\.includes\(\s*origin\s*\)/);
  });

  test("getCorsHeaders does NOT send Access-Control-Allow-Credentials unconditionally", () => {
    // Belt-and-braces: if someone added an unconditional ACAC header back to
    // the default headers object, a wildcard origin combined with credentials
    // would still be exploitable. The fixed version does not set ACAC at all
    // in the CORS region.
    expect(corsBlock).not.toMatch(/Access-Control-Allow-Credentials\s*"?\s*:\s*"?\s*true/i);
  });
});

// ── (A) CORS behavioral replica — proves the fixed parser+builder work ──
describe("sec-M4: CORS allow-list parser and getCorsHeaders behavior (replicated)", () => {
  // Intentionally mirrors the FIXED source. The source-level assertions
  // above guarantee the real hooks.server.ts matches this shape.
  function parseAllowedOrigins(envValue: string | undefined): string[] {
    return (envValue ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0 && s !== "*");
  }

  function getCorsHeaders(
    origin: string | null,
    allowed: string[],
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (!origin) return headers;
    if (allowed.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
  }

  test("parser strips '*' entries from the allow-list", () => {
    expect(parseAllowedOrigins("*")).toEqual([]);
    expect(parseAllowedOrigins("*,https://trusted.example"))
      .toEqual(["https://trusted.example"]);
    expect(parseAllowedOrigins(" * , https://trusted.example "))
      .toEqual(["https://trusted.example"]);
  });

  test("unset / empty env defaults to a deny-all allow-list", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(",,")).toEqual([]);
  });

  test("untrusted origin + wildcard env → NO Access-Control-Allow-Origin", () => {
    const allowed = parseAllowedOrigins("*");
    const headers = getCorsHeaders("https://evil.example", allowed);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("untrusted origin + explicit allow-list → NO Access-Control-Allow-Origin", () => {
    const allowed = parseAllowedOrigins("https://trusted.example");
    const headers = getCorsHeaders("https://evil.example", allowed);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("trusted origin + explicit allow-list → Access-Control-Allow-Origin matches", () => {
    const allowed = parseAllowedOrigins("https://trusted.example,https://other.example");
    const headers = getCorsHeaders("https://trusted.example", allowed);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://trusted.example");
  });

  test("no Origin header → no ACAO regardless of allow-list", () => {
    const allowed = parseAllowedOrigins("https://trusted.example");
    const headers = getCorsHeaders(null, allowed);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("preflight OPTIONS response does not enable credentials on a wildcard origin", () => {
    // Mirrors the handle() OPTIONS branch: it returns 204 with just
    // getCorsHeaders(request). There is no Access-Control-Allow-Credentials
    // in that header set, so credentialed preflight cannot succeed against
    // a wildcard env setting.
    const allowed = parseAllowedOrigins("*");
    const headers = getCorsHeaders("https://evil.example", allowed);
    const preflight = new Response(null, { status: 204, headers });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("preflight OPTIONS for a trusted origin echoes the origin without creds", () => {
    const allowed = parseAllowedOrigins("https://trusted.example");
    const headers = getCorsHeaders("https://trusted.example", allowed);
    const preflight = new Response(null, { status: 204, headers });
    expect(preflight.headers.get("Access-Control-Allow-Origin"))
      .toBe("https://trusted.example");
    // Credentials must not be enabled — even for trusted origins the fix
    // doesn't set ACAC. Cookies are same-origin only by construction.
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

// ── (B) pi_session migration source-level regression gates ─────────────
describe("sec-M4: pi_session migration bridge has a hard expiry (source)", () => {
  test("PI_SESSION_MIGRATION_EXPIRES_AT constant is defined", () => {
    expect(HOOKS_SRC).toMatch(/PI_SESSION_MIGRATION_EXPIRES_AT\s*=\s*Date\.parse\(/);
  });

  test("migration bridge checks Date.now() against the expiry constant", () => {
    const block = extractPiSessionBlock(HOOKS_SRC);
    expect(block).toMatch(/Date\.now\(\)\s*>\s*PI_SESSION_MIGRATION_EXPIRES_AT/);
  });

  test("post-expiry branch does NOT set ezcorp_session from the legacy cookie", () => {
    const { expired } = migrationExpiryBranches();
    const calls = callsIn(expired);
    expect(calls.filter((call) => setsCookie(call, "pi_session", ""))).toHaveLength(1);
    expect(assignsLegacySession(expired)).toBe(false);
    expect(calls.some((call) => ts.isIdentifier(call.expression) &&
      call.expression.text === "setSessionCookie")).toBe(false);
    expect(calls.some((call) => ts.isPropertyAccessExpression(call.expression) &&
      call.expression.getText(hooksAst) === "event.cookies.set" &&
      ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === "ezcorp_session")).toBe(false);
  });

  test("pre-expiry branch DOES promote legacy token to ezcorp_session", () => {
    const { live } = migrationExpiryBranches();
    expect(assignsLegacySession(live)).toBe(true);
    expect(callsIn(live).some((call) => ts.isIdentifier(call.expression) &&
      call.expression.text === "setSessionCookie" &&
      call.arguments.map((arg) => arg.getText(hooksAst)).join(",") === "event.cookies,legacyToken")).toBe(true);
  });
});

// ── (B) pi_session migration behavioral replica ────────────────────────
describe("sec-M4: pi_session migration bridge gate logic (replicated)", () => {
  // Replicates the FIXED decision: given Date.now() and the expiry cutoff,
  // decide whether to (purge-only) or (purge + promote). The source
  // assertions above guarantee hooks.server.ts matches this shape.
  type CookieOp =
    | { op: "set"; name: string; value: string; maxAge: number }
    | { op: "get"; name: string };

  function runMigrationBridge(opts: {
    now: number;
    expiresAt: number;
    ezcorpSession: string | undefined;
    piSession: string | undefined;
  }): { sessionToken: string | undefined; ops: CookieOp[] } {
    const ops: CookieOp[] = [];
    let sessionToken = opts.ezcorpSession;
    if (!sessionToken) {
      const legacyToken = opts.piSession;
      if (legacyToken) {
        if (opts.now > opts.expiresAt) {
          ops.push({ op: "set", name: "pi_session", value: "", maxAge: 0 });
        } else {
          sessionToken = legacyToken;
          ops.push({ op: "set", name: "pi_session", value: "", maxAge: 0 });
          ops.push({
            op: "set",
            name: "ezcorp_session",
            value: legacyToken,
            maxAge: 30 * 24 * 3600,
          });
        }
      }
    }
    return { sessionToken, ops };
  }

  const EXPIRES_AT = Date.parse("2026-06-01T00:00:00Z");

  test("no cookies at all → nothing happens", () => {
    const r = runMigrationBridge({
      now: Date.parse("2026-05-01T00:00:00Z"),
      expiresAt: EXPIRES_AT,
      ezcorpSession: undefined,
      piSession: undefined,
    });
    expect(r.sessionToken).toBeUndefined();
    expect(r.ops).toEqual([]);
  });

  test("ezcorp_session already present → legacy cookie is ignored", () => {
    const r = runMigrationBridge({
      now: Date.parse("2026-05-01T00:00:00Z"),
      expiresAt: EXPIRES_AT,
      ezcorpSession: "new-token",
      piSession: "legacy-token",
    });
    expect(r.sessionToken).toBe("new-token");
    expect(r.ops).toEqual([]);
  });

  test("legacy cookie within expiry window → promoted once and cleared", () => {
    const r = runMigrationBridge({
      now: Date.parse("2026-05-15T00:00:00Z"),
      expiresAt: EXPIRES_AT,
      ezcorpSession: undefined,
      piSession: "legacy-token",
    });
    expect(r.sessionToken).toBe("legacy-token");
    // Two cookie operations: clear pi_session, set ezcorp_session.
    expect(r.ops).toHaveLength(2);
    expect(r.ops[0]).toEqual({ op: "set", name: "pi_session", value: "", maxAge: 0 });
    expect(r.ops[1]).toEqual({
      op: "set",
      name: "ezcorp_session",
      value: "legacy-token",
      maxAge: 30 * 24 * 3600,
    });
  });

  test("legacy cookie past expiry → rejected, purged, NOT promoted", () => {
    const r = runMigrationBridge({
      now: Date.parse("2026-07-01T00:00:00Z"),
      expiresAt: EXPIRES_AT,
      ezcorpSession: undefined,
      piSession: "legacy-token",
    });
    // Crucially: sessionToken must NOT be set from the legacy cookie.
    expect(r.sessionToken).toBeUndefined();
    // Exactly one op: purge the stale cookie. No ezcorp_session set.
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toEqual({ op: "set", name: "pi_session", value: "", maxAge: 0 });
    expect(r.ops.some(o => o.op === "set" && o.name === "ezcorp_session")).toBe(false);
  });

  test("legacy cookie exactly at the boundary → still promoted (strict >)", () => {
    // The fixed guard is `Date.now() > PI_SESSION_MIGRATION_EXPIRES_AT`
    // (strict). At exactly the cutoff ms the cookie is still promoted.
    const r = runMigrationBridge({
      now: EXPIRES_AT,
      expiresAt: EXPIRES_AT,
      ezcorpSession: undefined,
      piSession: "legacy-token",
    });
    expect(r.sessionToken).toBe("legacy-token");
  });
});
