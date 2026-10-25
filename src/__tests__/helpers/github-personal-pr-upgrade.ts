import { sql } from "drizzle-orm";
import type { MigrationDb } from "../../db/migrations/types";
import { up } from "../../db/migrations/add-github-personal-pr-workspace-authority";
import { releaseRows } from "../../db/queries/extension-releases";

/** Only for a fresh, private test database. Reconstruct the installed legacy column set. */
export async function exercisePersonalPrAuthorityUpgrade(db: MigrationDb) {
  await db.execute(sql`ALTER TABLE github_personal_pr_imports DROP COLUMN workspace_authority`);
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name) VALUES ('upgrade-owner','upgrade@example.test','hash','Owner')`);
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES ('upgrade-project','Existing private workspace','/existing-private')`);
  await db.execute(sql`INSERT INTO github_personal_pr_imports
    (id,owner_id,project_id,binding_id,workspace_revision,provider_generation,resource_id,repository_id,repository_name,base_ref,base_sha,base_digest,state,operation_id,idempotency_key,artifact)
    VALUES ('legacy-import','upgrade-owner','upgrade-project','legacy-binding',7,4,'legacy-resource',42,'owner/repo','main','saved-base-sha','saved-tree-digest','ready','saved-import-operation','saved-request-key','[{"path":"src/app.txt","mode":"100644","data":"c2F2ZWQ="}]')`);
  const saved = async () => releaseRows<Record<string, unknown>>(await db.execute(sql`SELECT id,owner_id,project_id,binding_id,workspace_revision,provider_generation,resource_id,repository_id,repository_name,base_ref,base_sha,base_digest,state,operation_id,idempotency_key,artifact FROM github_personal_pr_imports WHERE id='legacy-import'`))[0];
  const before = await saved();
  await up(db);
  const after = await saved();
  const [authority] = releaseRows<{ workspace_authority: unknown }>(await db.execute(sql`SELECT workspace_authority FROM github_personal_pr_imports WHERE id='legacy-import'`));
  await up(db);
  return { before, after, afterRerun: await saved(), authority: authority!.workspace_authority };
}
