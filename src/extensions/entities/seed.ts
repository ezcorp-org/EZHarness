// ── Seed-on-install for declared entities ────────────────────────
//
// Phase 3 ships the iteration scaffold + the no-`{file:...}` happy
// path. Phase 6 fills in `resolveFilePlaceholders` so string values of
// the form `{file:./prompts/weekly.md}` are read from the extension's
// source dir at install time. The shape is fixed here so Phase 6's
// patch is a body-only change.
//
// Idempotency: the seed runs on every install (fresh + reinstall +
// post-update). For each declaration we read the managed index and
// skip any slug already present. Newly-introduced seeds in a manifest
// update get inserted automatically; the user's edits to existing
// records survive.
//
// Per-entity scope rules: seed inserts into the SAME storage scope the
// declaration uses. For `scope: "user"` (default), the installer
// supplies the installing user's id; for `scope: "conversation"`, the
// installer ALWAYS skips seeding because we don't have a conversation
// id at install time (the SDK schema reserves the scope; conversation-
// scoped seeds need a different lifecycle — deferred to v2 per the
// spec's out-of-scope list).
//
// Validation: each seed record is validated via the SDK's `assertRecord`
// before write. A failure throws — install fails (caller's choice;
// `installer.ts` currently surfaces this as the install error).
//
// Soft-fail vs hard-fail on missing `{file:...}` target: Phase 6 will
// log a warning, drop the placeholder string, and continue (the
// extension still installs; the seed for that record is skipped). Phase
// 3 hard-fails on placeholder syntax to keep the contract loud — the
// flag is here so Phase 6 flips it without rewriting the loop.

import {
  ENTITY_INDEX_PREFIX,
  ENTITY_KEY_PREFIX,
  assertRecord,
  assertValidSlug,
  type EntityDeclaration,
  type EntitySeedSpec,
} from "@ezcorp/sdk/entities";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { createHostEntityStore } from "./host-store";

export interface EntitySeedOptions {
  extensionId: string;
  /** Manifest's `entities[]` block. Empty / undefined ⇒ no-op. */
  entities: readonly EntityDeclaration[] | undefined;
  /** Absolute path to the extension's install dir; used by Phase 6's
   *  `{file:...}` resolver. Phase 3 ignores it for the placeholder-less
   *  happy path. */
  sourceDir: string;
  /** Installing user's id, used for `scope: "user"` (and project) seeds.
   *  `null` skips user-scoped seeds (e.g. bundled installs at boot
   *  where there's no acting user yet — the seed runs on first access). */
  userId: string | null;
}

export interface EntitySeedResult {
  /** Per-entity-type record of slugs newly inserted by this run. */
  seededByType: Record<string, string[]>;
  /** Per-entity-type record of slugs skipped because they already
   *  existed at the same scope. */
  skippedByType: Record<string, string[]>;
}

/**
 * Thrown by `resolveFilePlaceholders` when a `{file:...}` reference
 * fails to resolve (escape attempt, missing file, etc.). The seed
 * loop catches this per-record and SKIPS the seed entry with a
 * warning — the install proceeds.
 */
export class FilePlaceholderError extends Error {
  readonly placeholder: string;
  constructor(message: string, placeholder: string) {
    super(message);
    this.name = "FilePlaceholderError";
    this.placeholder = placeholder;
  }
}

const FILE_PLACEHOLDER_REGEX = /^\{file:(.+)\}$/;

/**
 * Read a file from disk synchronously, scoped to the extension's
 * install dir. Returns the file contents as a UTF-8 string.
 *
 * Path-traversal clamp: the resolved absolute path MUST stay inside
 * `sourceDir`. A relative path with `..` segments that escapes the
 * dir, or an absolute path entirely, throws `FilePlaceholderError`.
 *
 * The sync read is intentional — seed runs at install time, off the
 * hot path, and a sync read keeps the recursive walker simple.
 * `Bun.file().text()` is async, so we use `node:fs.readFileSync` via
 * the file API. Bun's `Bun.file().textSync()` would also work but is
 * less portable across host runtimes.
 */
function readPlaceholderFile(rawPath: string, sourceDir: string): string {
  if (isAbsolute(rawPath)) {
    throw new FilePlaceholderError(
      `Absolute paths are not allowed in {file:…} placeholders: ${JSON.stringify(rawPath)}`,
      rawPath,
    );
  }
  const normalized = normalize(rawPath);
  const absSource = resolve(sourceDir);
  const absTarget = resolve(absSource, normalized);
  // Lexical path-traversal clamp: the resolved target must remain
  // under `absSource`. We compare with the trailing platform-
  // appropriate separator so a sibling dir whose name starts with the
  // same prefix can't sneak through (`<sourceDir>-evil/foo` would
  // otherwise pass a naive startsWith). `path.sep` rather than a
  // hardcoded `/` so the check stays correct if this ever runs under
  // Windows (defense-in-depth; codebase targets Bun/Linux today).
  const sourceWithSep = absSource.endsWith(sep) ? absSource : absSource + sep;
  if (absTarget !== absSource && !absTarget.startsWith(sourceWithSep)) {
    throw new FilePlaceholderError(
      `Path escapes source dir: ${JSON.stringify(rawPath)}`,
      rawPath,
    );
  }
  // Symlink-escape clamp: the lexical check above defeats `..`
  // traversal, but a symlink INSIDE `sourceDir` could still point at
  // `/etc/passwd` (or any other host file). Resolve both ends with
  // `realpathSync` and verify the target's real path stays inside the
  // source's real path. We do this AFTER the lexical clamp so that a
  // missing/dangling source dir surfaces as a clean
  // `FilePlaceholderError` rather than the raw ENOENT message.
  let realSource: string;
  let realTarget: string;
  try {
    realSource = realpathSync(absSource);
  } catch (err) {
    throw new FilePlaceholderError(
      `Source dir not accessible: ${(err as Error).message}`,
      rawPath,
    );
  }
  try {
    realTarget = realpathSync(absTarget);
  } catch (err) {
    // Missing file goes through the read attempt below to keep the
    // existing error message contract.
    realTarget = absTarget;
    void err;
  }
  const realSourceWithSep = realSource.endsWith(sep) ? realSource : realSource + sep;
  if (realTarget !== realSource && !realTarget.startsWith(realSourceWithSep)) {
    throw new FilePlaceholderError(
      `Path escapes source dir (symlink): ${JSON.stringify(rawPath)}`,
      rawPath,
    );
  }
  // node:fs.readFileSync — sync is intentional (seed runs off the hot
  // path, kilobyte files only). Throws on missing file; we wrap in
  // `FilePlaceholderError` so the seed loop can attribute the failure.
  try {
    return readFileSync(absTarget, "utf-8");
  } catch (err) {
    throw new FilePlaceholderError(
      `Failed to read ${JSON.stringify(rawPath)}: ${(err as Error).message}`,
      rawPath,
    );
  }
}

/**
 * Resolve `{file:./relative/path}` placeholders in seed string values.
 *
 * Phase 6 implementation:
 *   - walks the record recursively (objects, arrays, primitives)
 *   - for every string value matching /^\{file:(.+)\}$/, reads the file
 *     under `sourceDir` and substitutes its contents
 *   - throws `FilePlaceholderError` on missing/escaping paths; the
 *     seed loop catches per-record and skips the entry with a warning
 *
 * Only literal pre-and-post `{file:...}` patterns are recognized —
 * embedded `Hello {file:./x.md} world` would NOT trigger resolution
 * (matches the substack-pilot prior contract).
 */
export function resolveFilePlaceholders<T>(data: T, sourceDir: string): T {
  return walkPlaceholders(data, sourceDir) as T;
}

function walkPlaceholders(value: unknown, sourceDir: string): unknown {
  if (typeof value === "string") {
    const m = FILE_PLACEHOLDER_REGEX.exec(value);
    if (!m) return value;
    return readPlaceholderFile(m[1]!.trim(), sourceDir);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walkPlaceholders(v, sourceDir));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkPlaceholders(v, sourceDir);
    }
    return out;
  }
  return value;
}

/**
 * For each entity declaration, insert any seed records the user
 * doesn't already have. Returns a per-type summary for the caller to
 * write into the install audit row.
 */
export async function runEntitySeed(
  opts: EntitySeedOptions,
): Promise<EntitySeedResult> {
  const result: EntitySeedResult = {
    seededByType: {},
    skippedByType: {},
  };

  const declarations = opts.entities ?? [];
  if (declarations.length === 0) return result;

  for (const decl of declarations) {
    const seeds = decl.seed ?? [];
    if (seeds.length === 0) continue;

    const scope = decl.scope ?? "user";

    // Conversation-scoped seeds have no install-time scopeId; defer
    // to v2 per the spec's out-of-scope list. The seed loop logs the
    // skip and continues.
    if (scope === "conversation") {
      result.skippedByType[decl.type] = seeds.map((s) => s.slug);
      continue;
    }

    // User/project-scoped seeds need a scopeId. If none is supplied
    // (bundled-at-boot install), skip; the seed will run on first
    // access via a future hook (deferred — not in scope for Phase 3).
    if (!opts.userId) {
      result.skippedByType[decl.type] = seeds.map((s) => s.slug);
      continue;
    }

    const store = createHostEntityStore({
      extensionId: opts.extensionId,
      scope,
      scopeId: opts.userId,
    });

    // Read existing index once to detect already-seeded slugs.
    const indexKey = `${ENTITY_INDEX_PREFIX}${decl.type}`;
    const existingIndex = await store.get<unknown>(indexKey);
    const existingSlugs = new Set(
      existingIndex.exists && Array.isArray(existingIndex.value)
        ? (existingIndex.value as unknown[]).filter(
            (s): s is string => typeof s === "string",
          )
        : [],
    );

    const newlySeeded: string[] = [];
    const skipped: string[] = [];

    for (const seed of seeds as readonly EntitySeedSpec[]) {
      assertValidSlug(seed.slug, `entities[${decl.type}].seed.slug`);

      // Skip if already in the index OR if the record key exists
      // (defensive — index drift is possible on legacy installs).
      if (existingSlugs.has(seed.slug)) {
        skipped.push(seed.slug);
        continue;
      }
      const recordKey = `${ENTITY_KEY_PREFIX}${decl.type}:${seed.slug}`;
      const existingRecord = await store.get<unknown>(recordKey);
      if (existingRecord.exists) {
        skipped.push(seed.slug);
        continue;
      }

      let resolved: Record<string, unknown>;
      try {
        resolved = resolveFilePlaceholders(seed.data, opts.sourceDir);
      } catch (err) {
        if (err instanceof FilePlaceholderError) {
          // Soft-fail: skip this seed record, continue with the rest.
          // The install proceeds; the operator sees a clean warning.
          console.warn(
            `[entities/seed] ${decl.type}#${seed.slug}: ${err.message}`,
          );
          skipped.push(seed.slug);
          continue;
        }
        throw err;
      }

      // Validate against the declared schema. Hard-fail (throws) on
      // validation error — the caller (installer) surfaces it.
      assertRecord(
        decl.schema,
        resolved,
        `entities[${decl.type}].seed[${seed.slug}]`,
      );

      // Write the record + bump the index.
      await store.set(recordKey, resolved);
      existingSlugs.add(seed.slug);
      newlySeeded.push(seed.slug);
    }

    // Persist the updated index (sorted + deduped — mirrors the SDK
    // storage helper's `writeEntityIndex` semantics so test snapshots
    // match across the host-served and subprocess-served paths).
    if (newlySeeded.length > 0) {
      await store.set(indexKey, Array.from(existingSlugs).sort());
    }

    result.seededByType[decl.type] = newlySeeded;
    if (skipped.length > 0) result.skippedByType[decl.type] = skipped;
  }

  return result;
}
