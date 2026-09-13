import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

test("factory database boot can precede service startup without opening readiness", async () => {
  const fixture = await setupFactoryPostgres();
  const secrets = await mkdtemp(join(tmpdir(), "factory-boot-secrets-"));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        const { initDb, closeDb, getDb } = await import('./src/db/connection.ts');
        const { sql } = await import('drizzle-orm');
        const { getReadiness } = await import('./src/readiness.ts');
        const { assertFactoryBootReadiness } = await import('./src/factory/boot.ts');
        try {
          await initDb();
          await getDb().execute(sql.raw('SELECT 1'));
          if (getReadiness().state === 'ready') throw new Error('factory ready before service probes');
          try { assertFactoryBootReadiness(process.env.DATABASE_URL); throw new Error('missing services accepted'); }
          catch (error) { if (error.code !== 'factory-services-unavailable') throw error; }
          console.log('database-open-services-unready');
        } finally { await closeDb(); }
      `],
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: fixture.databaseUrl, EZCORP_FACTORY_ENABLED: "1", EZCORP_INSTALLATION_ID: "factory-boot-test", EZCORP_SECRETS_DIR: secrets },
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, output: output.includes("database-open-services-unready"), serviceFailure: error.includes("factory-services-unavailable") }).toEqual({ exit: 0, output: true, serviceFailure: false });
  } finally { await fixture.close(); await rm(secrets, { recursive: true, force: true }); }
}, 60_000);
