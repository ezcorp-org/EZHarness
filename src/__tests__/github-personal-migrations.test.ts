import { afterAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { migrate } from "../db/migrate";
import { up as addConnections } from "../db/migrations/add-github-user-connections";
import { up as addDeviceAttempts } from "../db/migrations/add-github-user-device-attempts";
import { closeTestDb, getTestDb, setupTestDb } from "./helpers/test-pglite";

const owner = "github-migration-owner";
const project = "github-migration-project";

beforeEach(async () => {
  await setupTestDb();
  const db = getTestDb();
  // Keep the real application schema and existing data, but remove this feature's
  // tables to exercise their creation against an already-installed application.
  await db.execute(sql`DROP TABLE github_personal_pr_proposals, github_personal_pr_snapshots,
    github_personal_pr_imports, github_user_device_attempts, github_user_oauth_attempts,
    github_user_effect_claims, github_user_connections, github_user_authorities`);
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role)
    VALUES (${owner},'github-migration@example.test','hash','Existing user','member')`);
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${project},'Existing project','/existing')`);
  await db.execute(sql`INSERT INTO conversations(id,project_id,title,user_id)
    VALUES ('github-migration-chat',${project},'Existing conversation',${owner})`);
  await db.execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at)
    VALUES ('github-migration-run','agent',${project},'github-migration-chat',${owner},'success',NOW(),NOW())`);
});

afterAll(closeTestDb);

test("upgrades existing OAuth credentials without changing their provenance or ciphertext", async () => {
  const db = getTestDb();
  await addConnections(db);
  await db.execute(sql`INSERT INTO github_user_authorities(user_id,generation) VALUES (${owner},7)`);
  await db.execute(sql`INSERT INTO github_user_connections
    (user_id,connection_id,github_account_id,github_login,app_id,access_ciphertext,refresh_ciphertext,
     access_expires_at,refresh_expires_at,token_revision,state)
    VALUES (${owner},'existing-connection',42,'existing-user',123,'encrypted-access','encrypted-refresh',
      '2030-01-01','2031-01-01',3,'reconnect_required')`);
  await db.execute(sql`INSERT INTO github_user_oauth_attempts
    (state_digest,user_id,session_digest,expected_generation,verifier_ciphertext,expires_at)
    VALUES ('existing-state',${owner},'existing-session',7,'encrypted-verifier','2030-01-01')`);

  await migrate(db);
  const readConnection = async () => (await db.execute(sql`SELECT connection_id,github_account_id,
    access_ciphertext,refresh_ciphertext,token_revision,state,auth_flow
    FROM github_user_connections WHERE user_id=${owner}`)).rows;
  expect(await readConnection()).toEqual([{
    connection_id: "existing-connection", github_account_id: 42,
    access_ciphertext: "encrypted-access", refresh_ciphertext: "encrypted-refresh",
    token_revision: 3, state: "reconnect_required", auth_flow: "oauth",
  }]);
  expect((await db.execute(sql`SELECT generation FROM github_user_authorities WHERE user_id=${owner}`)).rows)
    .toEqual([{ generation: 7 }]);
  expect((await db.execute(sql`SELECT verifier_ciphertext FROM github_user_oauth_attempts
    WHERE state_digest='existing-state'`)).rows).toEqual([{ verifier_ciphertext: "encrypted-verifier" }]);

  // A later device connection must not be relabelled as OAuth on another boot.
  await db.execute(sql`UPDATE github_user_connections SET auth_flow='device' WHERE user_id=${owner}`);
  const before = await readConnection();
  await addConnections(db);
  await addDeviceAttempts(db);
  await migrate(db);
  expect(await readConnection()).toEqual(before);
  expect((await db.execute(sql`SELECT name FROM projects WHERE id=${project}`)).rows)
    .toEqual([{ name: "Existing project" }]);
});

test("preserves frozen reviews on repeated migration and enforces owner and artifact foreign keys", async () => {
  const db = getTestDb();
  await migrate(db);
  await db.execute(sql`INSERT INTO github_personal_pr_imports
    (id,owner_id,project_id,conversation_id,binding_id,workspace_revision,provider_generation,
     resource_id,repository_id,repository_name,base_ref,base_sha,base_digest,state,operation_id,idempotency_key,artifact)
    VALUES ('existing-import',${owner},${project},'github-migration-chat','binding',2,4,'resource',42,
      'owner/repository','release/1','base-sha','base-digest','ready','import-operation','import-key','[]')`);
  await db.execute(sql`INSERT INTO github_personal_pr_snapshots
    (id,import_id,owner_id,project_id,conversation_id,run_id,binding_id,workspace_revision,
     provider_generation,resource_id,repository_id,base_sha,tree_digest,artifact,checks)
    VALUES ('existing-snapshot','existing-import',${owner},${project},'github-migration-chat',
      'github-migration-run','binding',2,4,'resource',42,'base-sha','tree-digest','[]','[]')`);
  await db.execute(sql`INSERT INTO github_personal_pr_proposals
    (id,snapshot_id,owner_id,github_account_id,connection_generation,repository_id,base_sha,
     title,body,digest,state,operation_id,branch,expires_at)
    VALUES ('existing-proposal','existing-snapshot',${owner},42,7,42,'base-sha','Reviewed title',
      'Reviewed body','review-digest','creating','publication-operation','ez-personal/old','2030-01-01')`);
  const readReview = async () => (await db.execute(sql`SELECT proposal.*,snapshot.artifact,snapshot.tree_digest
    FROM github_personal_pr_proposals proposal
    JOIN github_personal_pr_snapshots snapshot ON snapshot.id=proposal.snapshot_id
    WHERE proposal.id='existing-proposal'`)).rows;
  // Recreate a review written before durable publication claims were added.
  await db.execute(sql`ALTER TABLE github_personal_pr_proposals
    DROP COLUMN claim_owner, DROP COLUMN claim_expires_at`);
  const legacy = await readReview();
  await migrate(db);
  expect(await readReview()).toEqual(legacy.map(row => ({ ...row, claim_owner: null, claim_expires_at: null })));

  // Repeated boot must also preserve a claim that a current publisher owns.
  await db.execute(sql`UPDATE github_personal_pr_proposals
    SET claim_owner='active-publisher',claim_expires_at='2030-01-01' WHERE id='existing-proposal'`);
  const before = await readReview();
  await migrate(db);
  await migrate(db);
  expect(await readReview()).toEqual(before);

  await expect(Promise.resolve(db.execute(sql`INSERT INTO github_user_authorities(user_id) VALUES ('missing-user')`)))
    .rejects.toThrow();
  await db.execute(sql`INSERT INTO github_user_authorities(user_id) VALUES (${owner})`);
  await expect(Promise.resolve(db.execute(sql`UPDATE github_user_authorities SET generation=-1 WHERE user_id=${owner}`)))
    .rejects.toThrow();
  await expect(Promise.resolve(db.execute(sql`UPDATE github_personal_pr_proposals
    SET snapshot_id='missing-snapshot' WHERE id='existing-proposal'`))).rejects.toThrow();
  await expect(Promise.resolve(db.execute(sql`UPDATE github_personal_pr_snapshots
    SET import_id='missing-import' WHERE id='existing-snapshot'`))).rejects.toThrow();
  await expect(Promise.resolve(db.execute(sql`UPDATE github_personal_pr_imports
    SET owner_id='missing-user' WHERE id='existing-import'`))).rejects.toThrow();
  expect(await readReview()).toEqual(before);

  await db.execute(sql`DELETE FROM github_personal_pr_imports WHERE id='existing-import'`);
  expect((await db.execute(sql`SELECT id FROM github_personal_pr_snapshots`)).rows).toEqual([]);
  expect((await db.execute(sql`SELECT id FROM github_personal_pr_proposals`)).rows).toEqual([]);
  expect((await db.execute(sql`SELECT id FROM users WHERE id=${owner}`)).rows).toEqual([{ id: owner }]);
});
