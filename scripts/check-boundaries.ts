#!/usr/bin/env bun
/**
 * Architectural dependency-boundary gate.
 *
 * The existing `style/noRestrictedImports` denylist (biome.json +
 * dependency-denylist.test.ts) answers "which PACKAGES may we depend on".
 * This answers the orthogonal question: "which TREE may import which tree".
 *
 * ## Why a script and not a biome rule
 *
 * biome 2.5.6's `noRestrictedImports` does support `patterns[].group`
 * gitignore-style globs, and they DO match relative and alias specifiers —
 * verified against the real binary, not assumed. It is still the wrong tool
 * here, for two measured reasons:
 *
 *   1. `biome.json` excludes `**\/*.svelte`, so a biome rule is blind to every
 *      Svelte component. Biome CAN lint svelte script blocks; this repo turned
 *      it off, and un-excluding it surfaces ~2,472 `noUnusedVariables` false
 *      positives (biome does not parse Svelte templates, so a variable used
 *      only in markup reads as unused).
 *   2. Patterns match the RAW SPECIFIER, so they cannot resolve. A glob like
 *      `**\/src/**` cannot tell these apart, and all three exist in-tree:
 *        - `../src/client` inside packages/@ezcorp/ai-kit/test  → LEGAL (package-local)
 *        - `../src/lib/api.js` inside web/e2e                   → LEGAL (intra-web)
 *        - `../../../../src/extensions/types` from web/src/lib  → a real escape
 *      The 84 relative web→src escapes in-tree sit at six different `../`
 *      depths, so no fixed pattern separates them. A resolver does it exactly.
 *
 * ## Scope of THIS file
 *
 * Deliberately only the rules that are at ZERO violations today, so the gate
 * lands green with no baseline file. A baseline is an un-gating surface that
 * would itself need a ratchet in `gate-integrity.ts`; the rules that need one
 * (`web/src/lib/** -> src/**`, `src/** -> web/**`,
 * `docs/extensions/examples/** -> src/**`) are a separate change.
 */
import { resolve, dirname, relative } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");

/** Trees whose *runtime* code is a published/consumed artifact. */
const PACKAGE_PREFIX = "packages/@ezcorp/";

/**
 * The ONLY backend surface the Cloudflare Worker may import. CLAUDE.md
 * describes `worker/` as "LLM-only agents reusing `src/runtime/executor` with
 * stubbed shell/file providers", and worker/src/index.ts imports exactly
 * `src/types` + three `src/runtime/*` modules. Stated as an ALLOWLIST rather
 * than a denylist so a new import outside it fails by default — the failure
 * mode this protects against is a Workers deploy that breaks at runtime
 * because someone pulled in PGlite, a subprocess spawn, or node:fs.
 */
export const WORKER_ALLOWED_PREFIXES = ["src/runtime/"] as const;
export const WORKER_ALLOWED_EXACT = ["src/types"] as const;

/**
 * Named for the diagnostic: these are the subsystems that cannot run on
 * Workers at all. Every one is also caught by the allowlist above; listing
 * them separately buys a message that says WHY rather than just "not allowed".
 */
export const WORKER_FORBIDDEN_SUBSYSTEMS = [
  "db",
  "auth",
  "extensions",
  "providers",
  "memory",
] as const;

/** Import/export/require/dynamic-import specifier extraction. */
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(|\bimport\s*\()\s*["'`]([^"'`\n]+)["'`]/g;

export function extractSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(IMPORT_RE), (m) => m[1]!);
}

/**
 * True for test/spec files. The package rule applies to PRODUCTION code only:
 * a package's runtime is a published artifact and must not reach into the app,
 * but its tests legitimately assert parity against the app's canonical source
 * (e.g. harness-client's RUNTIME_EVENT_NAMES parity guard, ai-kit validating
 * its manifest with the host's authoritative validator). Forbidding those
 * would force duplicating the very constant the guard exists to compare
 * against. This is a principled distinction, not a per-file allowlist.
 */
export function isTestPath(p: string): boolean {
  return /(?:\.test\.|\.spec\.|__tests__\/|\/test\/)/.test(p);
}

/**
 * Resolve an import specifier to a repo-relative path, or null when it is not
 * a first-party target (bare package, node builtin, unresolvable).
 *
 * Handles the three first-party forms:
 *   - relative        → resolved against the IMPORTING FILE's directory
 *   - `$server/x`     → `src/x`          (web/svelte.config.js alias)
 *   - `$lib/x`        → `web/src/lib/x`  (SvelteKit convention)
 */
export function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith("$server/")) return "src/" + spec.slice("$server/".length);
  if (spec.startsWith("$lib/")) return "web/src/lib/" + spec.slice("$lib/".length);
  if (!spec.startsWith(".")) return null;
  const abs = resolve(dirname(resolve(REPO_ROOT, fromFile)), spec);
  const rel = relative(REPO_ROOT, abs);
  // Escapes the repo entirely — not our business.
  return rel.startsWith("..") ? null : rel;
}

/** Drop a trailing `.ts`/`.js` so `src/types.ts` and `src/types` compare equal. */
function bare(p: string): string {
  return p.replace(/\.(?:m|c)?[jt]sx?$/, "");
}

export type Violation = { from: string; spec: string; target: string; rule: string; why: string };

/**
 * Apply every boundary rule to one (importer, specifier) pair.
 * Returns null when the edge is legal — which includes every edge that does
 * not resolve to a first-party path at all.
 */
export function checkEdge(fromFile: string, spec: string): Violation | null {
  const target = resolveSpecifier(fromFile, spec);
  if (target === null) return null;
  const t = bare(target);
  const v = (rule: string, why: string): Violation => ({ from: fromFile, spec, target, rule, why });

  // ── packages/@ezcorp/** (production) must not reach into the app ──
  // A package is consumed outside this repo; an import of `src/**` or `web/**`
  // is unbuildable for anyone who installs it.
  if (fromFile.startsWith(PACKAGE_PREFIX) && !isTestPath(fromFile)) {
    if (t.startsWith("src/") || t.startsWith("web/")) {
      return v(
        "packages-no-app-imports",
        `a published package cannot import the app (${t}) — it would not resolve for a consumer`,
      );
    }
  }

  // ── worker/** may reach only the LLM-only runtime surface ──
  if (fromFile.startsWith("worker/") && t.startsWith("src/")) {
    const sub = t.slice("src/".length).split("/")[0] ?? "";
    if ((WORKER_FORBIDDEN_SUBSYSTEMS as readonly string[]).includes(sub)) {
      return v(
        "worker-no-node-only-subsystems",
        `src/${sub}/** cannot run on Cloudflare Workers (PGlite / subprocess / node:fs) — the deploy breaks at runtime, not at build`,
      );
    }
    const allowed =
      WORKER_ALLOWED_PREFIXES.some((p) => t.startsWith(p)) ||
      (WORKER_ALLOWED_EXACT as readonly string[]).includes(t);
    if (!allowed) {
      return v(
        "worker-runtime-allowlist",
        `worker/ may import only ${WORKER_ALLOWED_PREFIXES.join(", ")} and ${WORKER_ALLOWED_EXACT.join(", ")}`,
      );
    }
  }

  return null;
}

/** Check one file's whole source text. */
export function checkSource(fromFile: string, source: string): Violation[] {
  const out: Violation[] = [];
  for (const spec of extractSpecifiers(source)) {
    const v = checkEdge(fromFile, spec);
    if (v) out.push(v);
  }
  return out;
}

export function formatViolations(violations: readonly Violation[]): string {
  const lines = [`Dependency-boundary violations (${violations.length}):`, ""];
  for (const v of violations) {
    lines.push(`  ${v.from}`);
    lines.push(`    imports "${v.spec}"  ->  ${v.target}`);
    lines.push(`    [${v.rule}] ${v.why}`);
    lines.push("");
  }
  return lines.join("\n");
}

const SOURCE_RE = /\.(?:ts|tsx|js|mjs|cjs|svelte)$/;

async function main(): Promise<void> {
  const proc = Bun.spawnSync(["git", "ls-files"], { cwd: REPO_ROOT, stdout: "pipe" });
  const files = proc.stdout.toString().split("\n").filter((f) => SOURCE_RE.test(f));
  // A glob that matched nothing would make this gate silently vacuous.
  if (files.length < 100) {
    console.error(`check-boundaries: only ${files.length} source files found — refusing to pass vacuously`);
    process.exit(2);
  }
  const violations: Violation[] = [];
  for (const f of files) {
    const text = await Bun.file(resolve(REPO_ROOT, f)).text().catch(() => "");
    if (text) violations.push(...checkSource(f, text));
  }
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exit(1);
  }
  console.log(`Dependency boundaries OK — ${files.length} source files, 0 violations.`);
}

if (import.meta.main) {
  await main();
}
