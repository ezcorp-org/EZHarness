/**
 * The dependency PICKER's vocabulary: which installed rows can be
 * depended on, and what `source` each one declares.
 *
 * Split out of `ezcorp-config-edit.ts`, which owns a different job —
 * rewriting the managed blocks inside an `ezcorp.config.ts` source
 * string. These few values are the picker's contract with the HOST
 * validator, and they are the only part of that module the backend's
 * lockstep test needs to call.
 *
 * That separation is also what makes both files measurable. The
 * lockstep test (`src/__tests__/dependency-source-parity.test.ts`) runs
 * in the bun pool, which IS coverage-instrumented, and it has to invoke
 * `dependencySourceFor` for real — its whole point is that the panel
 * cannot bypass this module with an inlined literal. While these lived
 * in `ezcorp-config-edit.ts`, importing them dragged that entire file
 * into the bun shard's instrumentation, which emitted a record with all
 * ~200 lines of the source-text editor at zero hits. merge-lcov unions
 * that with the vitest leg's clean 100%, and because the two
 * instrumenters number lines differently the bun-only zeros survive —
 * so a fully-tested file reported 83.97%. Now the bun test imports only
 * what it exercises.
 *
 * LOCKSTEP (binding): every entry in `PICKER_DEPENDENCY_SOURCES` MUST be
 * accepted by the host's `validateDependencies`
 * (`src/extensions/manifest.ts`, which delegates the source check to
 * `src/extensions/dependency-source.ts`). Adding a form here without
 * teaching the host reddens that test — and it exists because the
 * failure mode is otherwise INVISIBLE: a composed dependency the
 * validator rejects looks completely fine in the panel and only blows
 * up, with a 422, when an author clicks Install.
 */

import type { DependencyEntry } from "./ezcorp-config-edit.js";

export const PICKER_DEPENDENCY_SOURCES = ["bundled", "local"] as const;
export type PickerDependencySource = (typeof PICKER_DEPENDENCY_SOURCES)[number];

/**
 * The VIRTUAL extension row the DB migration seeds so native tool calls
 * (`editFile`, `readFile`, …) have an `extension_id` to hang off. It is
 * not a real extension: no install path, no manifest tools, nothing to
 * depend ON. Offering it as a dependency produces a manifest naming an
 * extension that can never be resolved, so it is filtered out.
 */
export const VIRTUAL_BUILTIN_EXTENSION_ID = "builtin";

/** An installed row, as far as the dependency picker cares. */
export interface PickableExtension {
  id: string;
  name: string;
  version: string;
  /** The row's `source` column (`"builtin"` for the virtual row). */
  source?: string | null;
  /** True for first-party rows that ship with EZCorp. */
  isBundled?: boolean;
}

/**
 * Whether an installed row is a REAL extension that can be depended on.
 * Matched on both the id and the `source` column so the virtual row is
 * excluded however it is identified.
 */
export function isPickableDependency(
  ext: { id: string; source?: string | null },
): boolean {
  return (
    ext.id !== VIRTUAL_BUILTIN_EXTENSION_ID &&
    ext.source !== VIRTUAL_BUILTIN_EXTENSION_ID
  );
}

/** The dependency `source` to declare for an installed extension. */
export function dependencySourceFor(
  ext: { isBundled?: boolean },
): PickerDependencySource {
  return ext.isBundled === true ? "bundled" : "local";
}

/**
 * The managed dependency entry for a picked extension. The single place
 * the picker's `{name, source, version}` shape is built — the panel must
 * not inline its own literal, or the lockstep test above cannot see it.
 */
export function toDependencyEntry(ext: PickableExtension): DependencyEntry {
  return {
    name: ext.name,
    source: dependencySourceFor(ext),
    version: `^${ext.version}`,
  };
}
