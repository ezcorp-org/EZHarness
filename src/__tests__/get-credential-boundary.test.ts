/**
 * Phase 53.6 — `getCredential` boundary invariant regression test.
 *
 * Codifies the parent spec's mandate (tasks/v1.3-phase-53-bundled-
 * extension-ports.md, § 53.6.1):
 *
 *   > No `getCredential` imports remain outside `src/providers/` and
 *   > the host-side `llm-handler.ts` (grep verifies).
 *
 * Why: the manifest-clamp + bundled-trust security model funnels every
 * extension LLM call through `ctx.llm` → host-side `llm-handler.ts`,
 * which mediates credential resolution and writes a
 * `sdk_capability_calls` audit row. A single bypass — an extension or
 * runtime path importing `getCredential` directly — re-exposes the
 * audit-visibility gap that Phase 53 closed. The grep is a deliberate
 * architectural fence; this test makes it permanent.
 *
 * Allowlist resolution (verified at write time, 2026-05-09):
 *   - `src/providers/**` — the credential subsystem itself; defines
 *     `getCredential` and resolves it.
 *   - `src/extensions/llm-handler.ts` — the host-side LLM mediator
 *     for extension calls. The spec hypothesised
 *     `web/src/lib/server/llm-handler.ts`; the actual path is
 *     `src/extensions/llm-handler.ts` (verified via
 *     `find . -name 'llm-handler*'`).
 *   - Pre-existing host-side runtime + route callsites: every entry
 *     below is part of the host's chat / model-list / provider-test /
 *     agent-config code path — host-internal, never extension code.
 *     Adding a new entry to this allowlist is the friction the test
 *     exists to create: a reviewer must consciously assert "this
 *     callsite is host-side and respects the audit invariant".
 *
 * Test-only files (paths matching `__tests__/` or `*.test.ts`) are
 * exempt — tests legitimately mock `getCredential`.
 */
import { test, expect, describe } from "bun:test";
import { Glob } from "bun";
import { resolve, relative } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

/** Files outside `src/providers/**` permitted to import `getCredential`.
 *  `src/providers/**` is exempted unconditionally below (the credential
 *  module's own callers); this list is everything else. */
const ALLOWLIST = new Set<string>([
  // Host-side LLM mediator for extension calls — the audit chokepoint.
  "src/extensions/llm-handler.ts",
  // Runtime — chat agent + tool dispatch + executor helpers.
  // These are host-internal; extensions reach them only through
  // ToolExecutor, which gates by per-extension grants.
  "src/runtime/executor-helpers.ts",
  "src/runtime/stream-chat/setup-tools.ts",
  "src/runtime/stream-chat/build-pi-agent.ts",
  // Memory subsystem — compaction merge LLM call. Cross-extension,
  // host-internal, exposed via `runtime.memory.compact` invoke handler.
  "src/memory/compaction.ts",
  // Goal-host runtime controller — host-side evaluator credential
  // fallback (PRD FR-6 / D5). Loaded only by the runtime when a
  // conversation has an active goal; never bundled into extensions.
  "src/runtime/goal-host.ts",
  // SvelteKit route handlers — server-side endpoints, never bundled
  // into extension subprocesses.
  "web/src/routes/api/models/+server.ts",
  "web/src/routes/api/providers/[provider]/test/+server.ts",
  "web/src/routes/api/providers/[provider]/refresh-models/+server.ts",
  "web/src/routes/api/agent-configs/generate/+server.ts",
]);

/** Source roots scanned for getCredential imports. */
const ROOTS = ["src", "web/src", "packages"];

/** Detect a `getCredential` callable being pulled in from somewhere.
 *  Bare identifiers like `getCredentialFn` / `getCredentialAsync`
 *  shouldn't match — anchor on `getCredential` followed by a
 *  non-identifier char.
 *
 *  Static `import { … getCredential … } from "…"`:
 */
const STATIC_IMPORT = /\bimport\s*\{[^}]*\bgetCredential\b(?![A-Za-z0-9_])[^}]*\}\s*from\s*['"]/;
/** Dynamic `await import("…credentials")` followed by either a
 *  destructure of `getCredential` or a property access. Two shapes
 *  observed in the codebase:
 *    const { getCredential } = await import("…/credentials");
 *    const getCredential = (await import("…/credentials")).getCredential;
 *  Match the path-side anchor (the credentials file) so we don't
 *  flag dynamic imports of unrelated modules.
 */
const DYNAMIC_IMPORT_DESTRUCT = /\{\s*[^}]*\bgetCredential\b(?![A-Za-z0-9_])[^}]*\}\s*=\s*await\s+import\s*\(\s*['"][^'"]*credentials['"]\s*\)/;
const DYNAMIC_IMPORT_PROP = /await\s+import\s*\(\s*['"][^'"]*credentials['"]\s*\)\s*\)?\s*\.\s*getCredential\b/;
/** CommonJS require destructure (rare; included for completeness). */
const REQUIRE_DESTRUCT = /\{\s*[^}]*\bgetCredential\b(?![A-Za-z0-9_])[^}]*\}\s*=\s*require\s*\(\s*['"][^'"]*credentials['"]\s*\)/;

function isTestPath(rel: string): boolean {
  if (rel.includes("/__tests__/")) return true;
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return true;
  if (rel.endsWith(".spec.ts") || rel.endsWith(".spec.tsx")) return true;
  return false;
}

async function findCallsites(): Promise<string[]> {
  const offenders: string[] = [];

  for (const root of ROOTS) {
    const absRoot = resolve(repoRoot, root);
    const glob = new Glob("**/*.{ts,tsx}");
    for await (const relInRoot of glob.scan({ cwd: absRoot, onlyFiles: true })) {
      const abs = resolve(absRoot, relInRoot);
      const rel = relative(repoRoot, abs);

      if (isTestPath(rel)) continue;
      // The credentials module itself defines getCredential — exempt
      // anything under src/providers/**.
      if (rel.startsWith("src/providers/")) continue;
      // Type-only declaration files don't carry runtime imports.
      if (rel.endsWith(".d.ts")) continue;

      const text = await Bun.file(abs).text();
      // Cheap pre-filter — skip files that don't even mention the symbol.
      if (!text.includes("getCredential")) continue;

      const hasImport =
        STATIC_IMPORT.test(text) ||
        DYNAMIC_IMPORT_DESTRUCT.test(text) ||
        DYNAMIC_IMPORT_PROP.test(text) ||
        REQUIRE_DESTRUCT.test(text);
      if (!hasImport) continue;

      offenders.push(rel);
    }
  }
  return offenders.sort();
}

describe("getCredential boundary invariant", () => {
  test("only the documented host-side allowlist may import getCredential", async () => {
    const callsites = await findCallsites();
    const unauthorized = callsites.filter((p) => !ALLOWLIST.has(p));

    if (unauthorized.length > 0) {
      const message =
        "getCredential boundary breach — extensions and unrelated " +
        "modules must call through `ctx.llm` (mediated by " +
        "src/extensions/llm-handler.ts), not import getCredential " +
        "directly. Offending files:\n" +
        unauthorized.map((f) => `  - ${f}`).join("\n") +
        "\n\nIf the new callsite is genuinely host-side and audited, " +
        "add it to ALLOWLIST in this test with a one-line rationale.";
      throw new Error(message);
    }

    // Sanity: at least one allowlist entry should currently exist —
    // catch a regex regression that silently matches nothing.
    expect(callsites.length).toBeGreaterThan(0);
  });

  test("every allowlist entry corresponds to a real callsite (no stale entries)", async () => {
    const callsites = new Set(await findCallsites());
    const stale: string[] = [];
    for (const entry of ALLOWLIST) {
      if (!callsites.has(entry)) stale.push(entry);
    }

    if (stale.length > 0) {
      throw new Error(
        "Stale ALLOWLIST entries — these files no longer import " +
        "getCredential. Remove them so the allowlist stays " +
        "minimal:\n" +
        stale.map((f) => `  - ${f}`).join("\n"),
      );
    }
  });
});
