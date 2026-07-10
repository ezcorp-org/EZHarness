/**
 * Constants shared between the preprocess runner and OTHER subsystems
 * (goal-host's evaluator-transcript filter). Split out of preprocess.ts
 * so a constant-only importer never static-imports the runner module —
 * under bun's sharded coverage, a suite that imports a module WITHOUT
 * executing it emits 0-hit DA records for lines the owning suite's
 * shard never lists (type-signature lines), and merge-lcov SUMS shards,
 * failing the per-file gate (see lesson: bun coverage attribution
 * drift / dual-instrumenter split, PR #33 precedent).
 */

/** Role string for deterministic-preprocess result rows in `messages`. */
export const PREPROCESS_RESULT_ROLE = "preprocess-result";
