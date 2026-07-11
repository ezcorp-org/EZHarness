import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { settings } from "./schema";

const log = logger.child("db");

export const SELF_PROJECT_ID = "self";
export const SELF_PROJECT_DEFAULT_NAME = "EZCorp (this app)";
// Ships with the repo (web/static/), so every dev-mode install renders the
// same logo. Backfilled onto existing rows only while their icon is NULL —
// a user-chosen icon is never overwritten.
export const SELF_PROJECT_ICON = "/self-project-icon.png";

/**
 * Standing guidance for conversations in the self project, layered into every
 * conversation via `resolveSystemPrompt`'s `project:<id>:systemPrompt` setting.
 * Seeded ONCE on first insert only — user edits or deletion of the setting at
 * /project/self/settings must stick across reboots.
 */
export const SELF_PROJECT_SYSTEM_PROMPT = `This project is the live source tree of the EZCorp instance you are running in — the same files serve this app.

- web/src/** edits hot-reload in the running UI.
- src/** edits invalidate the backend mid-request and can kill YOUR OWN in-flight run: finish ALL file writes first, then apply them — ask the user to run \`docker compose restart app\` on the host, or run \`kill 1\` as the very last action of your turn (the container restarts automatically).
- package.json / bun.lock / scripts/** / packages/** edits persist to the checkout, but the running server keeps using the image's copy until a host-side \`docker compose up -d --build\`.
- The repo's .git is mounted read-only: git diff/log/status are fine for context, but commits, branches, stashes and pushes are impossible here — when you finish a change, summarize the edited files and let the human commit from the host.
- .env*, .ezcorp/ and worktrees/ are intentionally masked out; do not try to read or restore them.`;

/**
 * Env-gated, idempotent seed of the "self" project — a project whose `path`
 * is the app's own source checkout, so a dev-compose instance can dogfood
 * EZCorp on its own code. `EZCORP_SELF_PROJECT_PATH` is only set by the dev
 * compose stack (docker-compose.yml → /repo); everywhere else this is a no-op.
 *
 * Re-run semantics: the row's `path` follows the env var (mount moves are
 * self-healing), but a user-chosen `name`/`icon` and any edit/deletion of the
 * seeded system prompt are never clobbered. Deleting the project brings it
 * back on the next boot — by design for a dev affordance.
 *
 * Takes the migrate `db` handle directly for ALL SQL — getDb() is not
 * guaranteed wired during the migrate pass (same constraint as
 * `backfillGithubProjectsApiTokens`).
 */
// biome rule `suspicious/noExplicitAny` is off repo-wide; `db: any` matches
// migrate()'s own signature (PGlite vs Bun.sql drizzle HKT mismatch).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedSelfProject(db: any, env: Record<string, string | undefined> = process.env): Promise<void> {
  const path = env.EZCORP_SELF_PROJECT_PATH;
  if (!path) return;
  if (!existsSync(path)) {
    log.warn("EZCORP_SELF_PROJECT_PATH does not exist — skipping self-project seed", { path });
    return;
  }

  const result = await db.execute(sql`SELECT path, icon FROM projects WHERE id = ${SELF_PROJECT_ID}`);
  // bun-sql returns arrays, PGlite returns { rows }; normalize both shapes.
  const rows = ((result as { rows?: unknown }).rows ?? result) as Array<{ path: string; icon: string | null }>;
  const existing = rows[0];

  if (!existing) {
    const name = env.EZCORP_SELF_PROJECT_NAME || SELF_PROJECT_DEFAULT_NAME;
    await db.execute(
      sql`INSERT INTO projects (id, name, path, icon) VALUES (${SELF_PROJECT_ID}, ${name}, ${path}, ${SELF_PROJECT_ICON})`,
    );
    // First-insert-only (onConflictDoNothing + guarded by the row check
    // above): never re-seed a prompt the user edited or deleted. Column-mapped
    // insert, NOT a raw `${...}::jsonb` param: under Bun.sql the jsonb cast
    // context makes the driver JSON-encode the param a second time (the exact
    // double-encode failure documented in connection.ts), while the drizzle
    // column path is correct on both drivers — identity-mapper + driver
    // serialization on Bun.sql, JSON.stringify mapper on PGlite.
    await db
      .insert(settings)
      .values({
        key: `project:${SELF_PROJECT_ID}:systemPrompt`,
        value: SELF_PROJECT_SYSTEM_PROMPT,
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    log.info("Seeded self project", { path, name });
  } else if (existing.path !== path || existing.icon == null) {
    // Path follows the env var; icon is only FILLED when missing (rows
    // seeded before the icon existed) — COALESCE keeps a user-chosen icon.
    await db.execute(sql`
      UPDATE projects
      SET path = ${path}, icon = COALESCE(icon, ${SELF_PROJECT_ICON}), updated_at = NOW()
      WHERE id = ${SELF_PROJECT_ID}
    `);
    log.info("Self project updated", { path });
  }
}
