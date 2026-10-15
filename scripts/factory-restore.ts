#!/usr/bin/env bun
/**
 * The operator's restore command. See `src/factory/restore-command.ts`.
 *
 *   DATABASE_URL=... EZCORP_FACTORY_STARTUP_CONFIG=... bun scripts/factory-restore.ts begin --restore-id <id> --fence <attestation.json>
 */
import type { TransactionalDb } from "../src/db/migrations/types";
import { closeDb, getDb, initDb } from "../src/db/connection";
import { runFactoryRestoreCommand } from "../src/factory/restore-command";

if (import.meta.main) {
  process.exit(await runFactoryRestoreCommand(process.argv.slice(2), {
    env: process.env,
    out: line => console.log(line),
    database: async () => { await initDb(); return { db: getDb() as unknown as TransactionalDb, close: closeDb }; },
  }));
}
