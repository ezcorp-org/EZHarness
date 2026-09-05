import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ExtensionDeliveryQueue } from "./v4/deliveries";

for (const boundary of ["before", "after"] as const) test("SIGKILL " + boundary + " commit preserves domain/outbox atomicity across process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "extension-outbox-crash-"));
  const source = [
    "import { PGlite } from '@electric-sql/pglite';",
    "import { drizzle } from 'drizzle-orm/pglite';",
    "import { sql } from 'drizzle-orm';",
    "import { up } from " + JSON.stringify(resolve(import.meta.dir, "../db/migrations/add-extension-releases.ts")) + ";",
    "import { publishDomainEvent } from " + JSON.stringify(resolve(import.meta.dir, "domain-event-outbox.ts")) + ";",
    "const database = new PGlite(" + JSON.stringify(directory) + ");",
    "const driver = drizzle(database); await up(driver);",
    "await database.exec(\"CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT,title TEXT); CREATE TABLE extensions(id TEXT PRIMARY KEY,name TEXT,enabled BOOLEAN,granted_permissions JSONB); CREATE TABLE conversation_extensions(conversation_id TEXT,extension_id TEXT);\");",
    "await database.exec(\"INSERT INTO users VALUES ('owner','active'); INSERT INTO conversations VALUES ('conversation','owner',NULL,'original'); INSERT INTO conversation_extensions VALUES ('conversation','extension');\");",
    "await database.query('INSERT INTO extensions VALUES ($1,$2,$3,$4)', ['extension','probe',true,JSON.stringify({eventSubscriptions:['tool:complete']})]);",
    "const installation = {id:'extension',ownerId:'owner',scope:'global',activeReleaseId:'release',generation:1,enabled:true,uninstalled:false,status:'active',acknowledgedGeneration:1,grants:[JSON.stringify(['eventSubscriptions',['tool:complete']])]};",
    "await database.query('INSERT INTO extension_release_installations(id,owner_id,scope,payload) VALUES ($1,$2,$3,$4)', ['extension','owner','global',JSON.stringify(installation)]);",
    "await database.exec('CHECKPOINT');",
    "await driver.transaction(async transaction => {",
    "await transaction.execute(sql.raw(\"UPDATE conversations SET title = 'committed' WHERE id = 'conversation'\"));",
    "await publishDomainEvent(transaction,{id:'host-event',type:'tool:complete',conversationId:'conversation',payload:{toolName:'probe'}});",
    "if (" + JSON.stringify(boundary) + " === 'before') {console.log('CRASH_READY'); await new Promise(() => {});}",
    "});",
    "await database.exec('CHECKPOINT'); console.log('CRASH_READY'); await new Promise(() => {});",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--eval", source], { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      while (!output.includes("CRASH_READY")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Crash fixture exited before the boundary: " + await stderr);
        output += new TextDecoder().decode(chunk.value);
      }
    } finally { clearTimeout(timeout); reader.releaseLock(); }
    child.kill("SIGKILL");
    await child.exited;
    const recovered = new PGlite(directory);
    try {
      const state = await recovered.query<{ title: string }>("SELECT title FROM conversations WHERE id = 'conversation'");
      expect(state.rows[0]?.title).toBe(boundary === "after" ? "committed" : "original");
      const queue = new ExtensionDeliveryQueue(drizzle(recovered));
      let effects = 0;
      const delivery = await queue.dispatch(async () => { effects++; });
      expect(delivery?.state ?? null).toBe(boundary === "after" ? "delivered" : null);
      expect(await queue.dispatch(async () => { effects++; })).toBeNull();
      expect(effects).toBe(boundary === "after" ? 1 : 0);
    } finally { await recovered.close(); }
  } finally { child.kill("SIGKILL"); await child.exited; await rm(directory, { recursive: true, force: true }); }
}, 30_000);
