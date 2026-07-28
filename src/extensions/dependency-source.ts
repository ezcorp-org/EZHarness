/**
 * Dependency `source` forms — the ONE place that decides which strings a
 * manifest's `dependencies.<name>.source` may carry.
 *
 * There are two DISJOINT kinds, and the difference is what the installer
 * does with the string:
 *
 *  1. CLONEABLE — `github:user/repo`, `gitlab:org/project`,
 *     `https://host/repo.git`, `git@host:user/repo.git`, `file:///…`.
 *     `installWithDependencies` resolves these by `git clone`, which is
 *     exactly why `source-parser.ts` is strict about them: the parsed
 *     `cloneUrl`/`ref` reach `git clone` as ARGUMENTS, and a dependency
 *     installed this way INHERITS the root install's permission grants.
 *     Nothing here loosens that — cloneable sources still go through
 *     `parseSource` unchanged.
 *
 *  2. PREINSTALLED — the closed set below. These are never passed to git
 *     at all. They declare "this extension must ALREADY be installed on
 *     this host", and the installer resolves them BY NAME against the
 *     installed set — which is also how the runtime resolves them
 *     (`ExtensionRegistry.buildDepRoutes` maps declared dependency names
 *     to installed extension ids; `resolveDepTool` gates cross-extension
 *     `ezcorp/invoke` on that map). An unsatisfiable preinstalled
 *     dependency is a HARD install failure, never a silent pass.
 *
 * Why a CLOSED set rather than "any non-cloneable string": the source
 * field feeds a code path that used to be `git clone`-strict, so letting
 * an arbitrary string through would be a real widening. Everything that
 * is neither a member of this set nor `parseSource`-parseable is
 * rejected at manifest-validation time exactly as before.
 *
 * The extension-author composition picker only ever offers extensions
 * that ARE installed, so PREINSTALLED is the only honest thing it can
 * write — see `PICKER_DEPENDENCY_SOURCES` in
 * `web/src/lib/ezcorp-config-edit.ts`, locksteped to this module by
 * `src/__tests__/dependency-source-parity.test.ts`.
 */

import { parseSource } from "./source-parser";

/**
 * The closed set of non-cloneable dependency source forms.
 *
 * - `bundled` — the dependency ships with EZCorp (an `is_bundled` row).
 * - `local`   — the dependency was installed on this host by some other
 *               means (authored, local path, or previously cloned).
 *
 * Both mean the same thing to the installer: resolve by name, do not
 * clone. They are kept distinct because that is what the author sees in
 * the generated manifest, and a manifest should not lie about where its
 * dependency came from.
 */
export const PREINSTALLED_DEPENDENCY_SOURCES = ["bundled", "local"] as const;

export type PreinstalledDependencySource =
  (typeof PREINSTALLED_DEPENDENCY_SOURCES)[number];

const PREINSTALLED = new Set<string>(PREINSTALLED_DEPENDENCY_SOURCES);

/** Whether `source` declares an already-installed (never-cloned) dependency. */
export function isPreinstalledDependencySource(
  source: string,
): source is PreinstalledDependencySource {
  return PREINSTALLED.has(source);
}

/** Appended to a parse failure so the author learns the non-cloneable
 *  forms exist without `source-parser.ts` (the clone parser) having to
 *  advertise sources it will never clone. */
const PREINSTALLED_HINT =
  `Alternatively use ${PREINSTALLED_DEPENDENCY_SOURCES.map((s) => `"${s}"`).join(" or ")}` +
  ` for a dependency that must ALREADY be installed (it is never cloned).`;

/**
 * Validate one `dependencies.<name>.source` value.
 * Returns `null` when valid, or the failure message to report.
 */
export function validateDependencySource(source: string): string | null {
  if (isPreinstalledDependencySource(source)) return null;
  try {
    parseSource(source);
    return null;
  } catch (err) {
    return `${(err as Error).message}. ${PREINSTALLED_HINT}`;
  }
}
