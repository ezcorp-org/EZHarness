// Static isolation guard — the extension subsystem must NEVER be able to
// write to (nor freely read) the identity / auth / RBAC tables.
//
// WHY THIS TEST EXISTS
// --------------------
// Extensions run in sandboxed subprocesses and never hold a DB handle. Every
// DB touch is a reverse-RPC call to one of the ~20 host-side handlers wired in
// `tool-executor.ts` (`ezcorp/storage`, `ezcorp/memory`, `ezcorp/rbac-check`,
// …). Each handler is scoped BY HAND to its own table(s), and the handlers use
// raw `getDb()` / `sql` freely — so the isolation of the security-critical
// tables from extension code is, today, a CONVENTION, not something the type
// system or the DB layer enforces. Nothing structurally stops a future edit to
// a handler from importing `upsertGrant` or running `sql\`UPDATE users …\``.
//
// This meta-test turns that convention into an enforced, regression-proof
// invariant. It statically scans the whole `src/extensions/` tree and fails if
// any file:
//   (A) WRITES a security table (drizzle `.insert/.update/.delete(<table>)` or
//       raw `INSERT INTO / UPDATE … SET / DELETE FROM <table>`), OR
//   (B) imports a security-table drizzle SYMBOL from `db/schema` at all —
//       except an explicit, reviewed allowlist of host-side boot migrations
//       that only SELECT `users.id`, OR
//   (C) imports anything but a read-only symbol from a security QUERY module
//       (`db/queries/users`, `auth/extension-rbac`, …).
//
// The three prongs together mean the subprocess-reachable handler surface can
// touch these tables ONLY through the two reviewed read-only wrappers
// (`getUserById`, `hasExtensionScope`) — never a write, never a raw table
// reference. Grant MUTATIONS (`upsertGrant`/`deleteGrant`) and user mutations
// live exclusively in the admin-gated API routes under
// `web/src/routes/api/rbac/…`, outside this tree.
//
// NOT covered here (enforced elsewhere, by construction):
//   - `settings` / `extension_secrets`: host-only — there is NO reverse-RPC
//     method that routes to the secrets store, so a subprocess cannot reach it
//     (see `tool-executor.ts` router; `secrets-store.ts` has no `ezcorp/*`
//     wiring). The behavioral RBAC guarantees (deny-by-default, provenance
//     binding, foreign-extension spoof rejection) are covered by
//     `tool-executor.rbac-rpc.test.ts` and `extension-rbac-resolver.test.ts`.
//
// If this test fails, DO NOT relax it to make a handler compile. A handler that
// needs identity/RBAC data must go through a read-only wrapper added to
// READ_ONLY_QUERY_IMPORTS below (a conscious, reviewed act) — it must never
// gain a write path to these tables.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

// src/extensions (this file lives in src/extensions/__tests__)
const extDir = `${import.meta.dir}/..`;
const schemaPath = `${extDir}/../db/schema.ts`;

// Identity / auth / RBAC tables. SQL name → drizzle export symbol in
// `src/db/schema.ts`. A self-check below asserts this map matches the schema so
// the guard cannot silently rot if a table is renamed.
const SECURITY_TABLES: Record<string, string> = {
  users: "users",
  sessions: "sessions",
  password_reset_tokens: "passwordResetTokens",
  invites: "invites",
  teams: "teams",
  team_members: "teamMembers",
  extension_rbac_grants: "extensionRbacGrants",
};

const SECURITY_TABLE_NAMES = Object.keys(SECURITY_TABLES);
const SECURITY_SCHEMA_SYMBOLS = new Set(Object.values(SECURITY_TABLES));

// Files permitted to import a security-table schema symbol. These are
// host-side BOOT migrations (not subprocess-reachable) that only enumerate
// `users.id` to backfill per-user extension settings — SELECT, never write
// (prong A still forbids writes here). Paths are relative to `src/extensions/`.
// Adding an entry is a reviewed security decision: the file must only READ.
const SCHEMA_IMPORT_ALLOWLIST = new Set<string>([
  "migrations/memory-extractor-enabled.ts",
  "migrations/distiller-enabled.ts",
]);

// The ONLY symbols any extension-tree file may import from a security QUERY
// module. Both are read-only: `getUserById` returns a row (used host-side,
// never returned over RPC), `hasExtensionScope` resolves a boolean decision.
const READ_ONLY_QUERY_IMPORTS = new Set<string>(["getUserById", "hasExtensionScope"]);

// A module path (as written in an import) is a "security query module" if it
// resolves to one of these under any relative depth.
const SECURITY_QUERY_MODULE_RE =
  /(?:\.\.\/)+(?:auth\/extension-rbac|db\/queries\/(?:users|extension-rbac|sessions|invites|teams))(?:\.ts)?$/;

// A module path that resolves to `db/schema`.
const SCHEMA_MODULE_RE = /(?:\.\.\/)+db\/schema(?:\.ts)?$/;

// ── Tiny import parser ───────────────────────────────────────────────
// Returns one entry per `import … from "<module>"`, with the set of *imported*
// identifiers (the name BEFORE any `as` alias). Handles `import type`,
// default+named combos, and multi-line brace bodies. Namespace imports
// (`import * as x`) carry no named specifiers and are irrelevant here.

interface ParsedImport {
  module: string;
  names: string[];
}

function parseImports(src: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  const importRe = /import\s+[^;]*?from\s*["']([^"']+)["']/gs;
  for (const m of src.matchAll(importRe)) {
    const full = m[0];
    const module = m[1]!;
    const braces = full.match(/\{([^}]*)\}/s);
    const names = braces
      ? braces[1]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
          .filter(Boolean)
      : [];
    out.push({ module, names });
  }
  return out;
}

// Strip `//` line and `/* */` block comments so prose never trips the raw-SQL
// scan. String/template bodies are intentionally preserved — that is where a
// raw `sql\`UPDATE users …\`` write would live.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ── Collect the extension-tree source files (excluding tests) ────────

function collectFiles(): { rel: string; src: string }[] {
  const glob = new Glob("**/*.ts");
  const files: { rel: string; src: string }[] = [];
  for (const rel of glob.scanSync(extDir)) {
    if (rel.startsWith("__tests__/") || rel.includes("/__tests__/")) continue;
    files.push({ rel, src: readFileSync(`${extDir}/${rel}`, "utf8") });
  }
  return files;
}

const FILES = collectFiles();

// ── Self-checks: the guard cannot vacuously pass or silently rot ─────

describe("extension DB isolation — guard integrity", () => {
  test("the scan actually visits the extension tree", () => {
    // A broken glob / wrong base dir would make every prong pass vacuously.
    expect(FILES.length).toBeGreaterThan(30);
  });

  test("the security-table map matches src/db/schema.ts", () => {
    const schema = readFileSync(schemaPath, "utf8");
    for (const [table, symbol] of Object.entries(SECURITY_TABLES)) {
      const re = new RegExp(`export const ${symbol} = pgTable\\("${table}"`);
      expect(schema).toMatch(re);
    }
  });
});

// ── Prong A — no WRITES to any security table ───────────────────────

describe("extension DB isolation — no writes to identity/auth/RBAC tables", () => {
  test("no drizzle .insert/.update/.delete against a security table symbol", () => {
    const offences: string[] = [];
    for (const { rel, src } of FILES) {
      const code = stripComments(src);
      for (const symbol of SECURITY_SCHEMA_SYMBOLS) {
        const re = new RegExp(`\\.(insert|update|delete)\\(\\s*${symbol}\\b`);
        const hit = code.match(re);
        if (hit) offences.push(`${rel}: ${hit[0]} (drizzle write to '${symbol}')`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("no raw INSERT/UPDATE/DELETE SQL against a security table", () => {
    const offences: string[] = [];
    for (const { rel, src } of FILES) {
      const code = stripComments(src);
      for (const table of SECURITY_TABLE_NAMES) {
        const patterns = [
          new RegExp(`\\binsert\\s+into\\s+"?${table}"?`, "i"),
          new RegExp(`\\bupdate\\s+"?${table}"?\\s+set\\b`, "i"),
          new RegExp(`\\bdelete\\s+from\\s+"?${table}"?`, "i"),
        ];
        for (const re of patterns) {
          const hit = code.match(re);
          if (hit) offences.push(`${rel}: '${hit[0]}' (raw SQL write to '${table}')`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

// ── Prong B — no security-table schema SYMBOL imports (except allowlist) ──

describe("extension DB isolation — no raw security-table references", () => {
  test("only the reviewed migration allowlist imports a security-table schema symbol", () => {
    const offences: string[] = [];
    const seenAllowlisted = new Set<string>();
    for (const { rel, src } of FILES) {
      for (const imp of parseImports(src)) {
        if (!SCHEMA_MODULE_RE.test(imp.module)) continue;
        const forbidden = imp.names.filter((n) => SECURITY_SCHEMA_SYMBOLS.has(n));
        if (forbidden.length === 0) continue;
        if (SCHEMA_IMPORT_ALLOWLIST.has(rel)) {
          seenAllowlisted.add(rel);
          continue;
        }
        offences.push(`${rel}: imports security schema symbol(s) [${forbidden.join(", ")}] from '${imp.module}'`);
      }
    }
    expect(offences).toEqual([]);
    // Canary: the allowlisted migrations really do trip the detector, proving
    // the schema-symbol parser works against real imports (not a dead branch).
    expect([...seenAllowlisted].sort()).toEqual([...SCHEMA_IMPORT_ALLOWLIST].sort());
  });
});

// ── Prong C — security query-module imports must be read-only ────────

describe("extension DB isolation — security query modules are read-only", () => {
  test("every import from a users/rbac/session/invite/team query module is read-only", () => {
    const offences: string[] = [];
    const observed: string[] = [];
    for (const { rel, src } of FILES) {
      for (const imp of parseImports(src)) {
        if (!SECURITY_QUERY_MODULE_RE.test(imp.module)) continue;
        for (const name of imp.names) {
          observed.push(name);
          if (!READ_ONLY_QUERY_IMPORTS.has(name)) {
            offences.push(
              `${rel}: imports '${name}' from '${imp.module}' — not a reviewed read-only symbol (${[...READ_ONLY_QUERY_IMPORTS].join(", ")})`,
            );
          }
        }
      }
    }
    expect(offences).toEqual([]);
    // Canary: the parser genuinely observed the known read-only imports.
    expect(observed.length).toBeGreaterThan(0);
    for (const name of observed) expect(READ_ONLY_QUERY_IMPORTS.has(name)).toBe(true);
  });
});
