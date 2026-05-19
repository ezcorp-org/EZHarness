import { eq, and } from "drizzle-orm";
import { getDb } from "../connection";
import { userCommands, type UserCommand, type NewUserCommand } from "../schema";

/**
 * Thin CRUD wrapper over the `user_commands` table. This is the
 * DB-backed source of slash commands; the registry (see
 * `src/runtime/commands/registry.ts`) pairs these rows with the
 * filesystem-discovered commands when building a popover result set.
 *
 * On-conflict rename: callers writing through `createUserCommand` (and
 * `updateUserCommand` when the user passes a new name) get an
 * automatic `-2`, `-3`, … suffix when the desired name is already
 * taken. `findFreeName` is the helper that picks the smallest free
 * suffix per user. Mirrors the DB-level pre-flight rename applied in
 * src/db/migrate.ts so existing duplicates and new writes follow one
 * rule.
 */

export async function listUserCommands(userId: string): Promise<UserCommand[]> {
  return getDb()
    .select()
    .from(userCommands)
    .where(eq(userCommands.userId, userId));
}

export async function getUserCommand(
  userId: string,
  name: string,
): Promise<UserCommand | undefined> {
  const rows = await getDb()
    .select()
    .from(userCommands)
    .where(and(eq(userCommands.userId, userId), eq(userCommands.name, name)));
  return rows[0];
}

/**
 * Returns the smallest free name in the `${desiredName}`, `${desiredName}-2`,
 * `${desiredName}-3`, … sequence for the given user.
 *
 * Optional `ignoreName`: treat a row already named `ignoreName` as
 * absent (used by `updateUserCommand` so a row keeps its current name
 * during an update that doesn't actually rename it). Pass the row's
 * existing name to skip the self-collision.
 *
 * Handles gaps: if `a` and `a-3` exist but `a-2` is free, returns
 * `a-2`. Matches the on-conflict suffix scheme baked into the DB
 * migration's pre-flight rename.
 */
export async function findFreeName(
  userId: string,
  desiredName: string,
  ignoreName?: string,
): Promise<string> {
  // Pull every name for the user; the table is per-user-bounded so this
  // is cheap (slash-command counts are O(10s), not O(1000s)).
  const rows = await getDb()
    .select({ name: userCommands.name })
    .from(userCommands)
    .where(eq(userCommands.userId, userId));
  const taken = new Set<string>(
    rows.map((r: { name: string }) => r.name).filter((n: string) => n !== ignoreName),
  );

  if (!taken.has(desiredName)) return desiredName;
  // Suffix loop: linear in the number of taken matches. Bounded by the
  // per-user row count above, so worst case is O(N).
  for (let i = 2; ; i++) {
    const candidate = `${desiredName}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface CreateUserCommandInput {
  userId: string;
  name: string;
  description?: string;
  body: string;
  frontmatter?: Record<string, string>;
}

/**
 * Heuristic detector for Postgres "unique_violation" (SQLSTATE 23505).
 * Both `pg` (external Postgres via Bun.sql) and PGlite surface the
 * error code on the thrown object — `pg` exposes `code`, PGlite either
 * surfaces it directly or nests it under `cause` and may also include
 * the constraint name on `constraint`. Accept any of those signals so
 * the retry loop works under both runtimes.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint?: string; cause?: unknown };
  if (e.code === "23505") return true;
  if (typeof e.constraint === "string" && e.constraint.includes("uq_user_commands_user_name")) {
    return true;
  }
  if (e.cause && typeof e.cause === "object") {
    const c = e.cause as { code?: string; constraint?: string };
    if (c.code === "23505") return true;
    if (typeof c.constraint === "string" && c.constraint.includes("uq_user_commands_user_name")) {
      return true;
    }
  }
  return false;
}

export async function createUserCommand(
  input: CreateUserCommandInput,
): Promise<UserCommand> {
  // Resolve the saved name BEFORE the insert so we never trip the
  // unique-index violation in the happy path. The DB constraint is the
  // safety net; this is the UX layer that turns a duplicate POST into
  // a 201 with `name: "review-2"` instead of a 500.
  //
  // Race window: two concurrent POSTs for the same desired name read
  // the same taken-set, compute the same suffix, and the loser's
  // INSERT raises 23505. We catch that, re-resolve a free name, and
  // retry — bounded to 3 attempts so a pathological loop can never
  // hang the request.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const savedName = await findFreeName(input.userId, input.name);
    const now = new Date();
    const row: NewUserCommand = {
      id: crypto.randomUUID(),
      userId: input.userId,
      name: savedName,
      description: input.description ?? "",
      body: input.body,
      frontmatter: input.frontmatter ?? {},
      createdAt: now,
      updatedAt: now,
    };
    try {
      await getDb().insert(userCommands).values(row);
      return row as UserCommand;
    } catch (err) {
      lastErr = err;
      if (!isUniqueViolation(err)) throw err;
      // Same-name racer beat us. Loop: re-run findFreeName against the
      // now-updated taken-set and try the next suffix.
    }
  }
  throw lastErr;
}

export interface UpdateUserCommandInput {
  description?: string;
  body?: string;
  frontmatter?: Record<string, string>;
  /**
   * When set and different from the current `name`, the row is renamed.
   * The new name is run through `findFreeName` first so a collision
   * gets the same `-2`, `-3`, … suffix policy as creation. The caller
   * inspects the returned row's `name` to discover the canonical value
   * (which may differ from what they requested).
   *
   * v1 surfaces this through the API but the UI keeps the field
   * disabled on edit — rename-in-place is v1.5+ scope per the spec.
   */
  name?: string;
}

export async function updateUserCommand(
  userId: string,
  name: string,
  patch: UpdateUserCommandInput,
): Promise<UserCommand | undefined> {
  // Guard: confirm the row exists for this user before we issue an
  // UPDATE. Mirrors the pre-existing read-then-write pattern in
  // deleteUserCommand and keeps the 404-vs-noop signal honest.
  const existing = await getUserCommand(userId, name);
  if (!existing) return undefined;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.body !== undefined) updates.body = patch.body;
  if (patch.frontmatter !== undefined) updates.frontmatter = patch.frontmatter;

  let savedName = name;
  if (patch.name !== undefined && patch.name !== name) {
    // Pass `name` as `ignoreName` so the rename helper doesn't think
    // the row's own current name is a collision against the desired
    // new value (relevant only when patch.name === name, but a
    // safe-by-default guard here too).
    savedName = await findFreeName(userId, patch.name, name);
    updates.name = savedName;
  }

  await getDb()
    .update(userCommands)
    .set(updates)
    .where(and(eq(userCommands.userId, userId), eq(userCommands.name, name)));
  return getUserCommand(userId, savedName);
}

export async function deleteUserCommand(
  userId: string,
  name: string,
): Promise<boolean> {
  const existing = await getUserCommand(userId, name);
  if (!existing) return false;
  await getDb()
    .delete(userCommands)
    .where(and(eq(userCommands.userId, userId), eq(userCommands.name, name)));
  return true;
}
