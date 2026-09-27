import { errorChain } from "./error-chain";

/**
 * Recognise a Postgres unique violation (SQLSTATE 23505) through drizzle's
 * wrapper, under BOTH drivers.
 *
 * Its own module because two unrelated subsystems need the same answer —
 * the session backfill's concurrent-INSERT resolve and
 * `workflow_definitions`' name-collision 409 — and a second copy of this
 * rule is a copy that will be written against the wrong shape. It was:
 * the workflow classifier matched `err.message` for "23505" or the index
 * name, and neither ever appears there, so the 409 path was inert and the
 * route 500'd.
 *
 * drizzle wraps driver errors in a `DrizzleQueryError` whose message is the
 * QUERY and whose `.code` is undefined — the SQLSTATE lives on `.cause`,
 * and WHERE on the cause differs by driver (verified live 2026-07-16):
 * PGlite puts it on `.cause.code`; Bun.sql (external Postgres) sets
 * `.cause.code = "ERR_POSTGRES_SERVER_ERROR"` and carries the SQLSTATE on
 * `.cause.errno`. Check code AND errno at both levels (string-normalized)
 * so callers work under both runtimes — missing the Bun.sql shape made
 * every duplicate-create propagate and 500'd
 * GET /api/conversations/[id]/tree on external-Postgres deploys.
 *
 * Matching the CONSTRAINT name instead would be wrong for a second reason:
 * `migrate.ts` renames `pipeline_definitions → workflow_definitions`, and
 * Postgres does not rename a table's constraints with it, so a lineage
 * database still carries `pipeline_definitions_name_key`.
 */
export function isUniqueViolation(err: unknown): boolean {
  return errorChain(err).slice(0, 2).some((link) => link.code === "23505" || link.errno === "23505");
}
