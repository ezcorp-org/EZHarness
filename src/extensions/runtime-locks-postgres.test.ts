import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import { lockRuntimeAdmission } from "./runtime-locks";
import testImages from "../../scripts/test-images.json";

const container = `extension-lock-postgres-${crypto.randomUUID()}`;
const image = testImages.postgres;
let client: SQL;

async function podman(...args: string[]): Promise<string> {
  const child = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

beforeAll(async () => {
  await podman("run", "-d", "--name", container, "--pull=never", "--memory=256m", "-e", "POSTGRES_PASSWORD=fixture", "-p", "127.0.0.1::5432", image);
  const port = (await podman("port", container, "5432/tcp")).split(":").at(-1);
  await podman("exec", container, "sh", "-c", "for attempt in $(seq 1 100); do pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1");
  client = new SQL(`postgres://postgres:fixture@127.0.0.1:${port}/postgres`, { max: 3, connectionTimeout: 10 });
  await client`SELECT 1`;
  await client`CREATE TABLE extension_runtime_locks (lock_key text PRIMARY KEY, effects integer NOT NULL DEFAULT 0)`;
  await client`INSERT INTO extension_runtime_locks (lock_key) VALUES ('counter')`;
}, 30_000);

afterAll(async () => {
  await client?.close({ timeout: 1 });
  await podman("rm", "-f", container);
}, 10_000);

test("Postgres admission still serializes concurrent quota checks and inserts", async () => {
  const database = drizzle(client);
  const insert = (key: string) => database.transaction(async (transaction) => {
    await lockRuntimeAdmission(transaction);
    const count = await transaction.execute(sql`SELECT COUNT(*)::int AS count FROM extension_runtime_locks`);
    if (count[0].count >= 2) return false;
    await transaction.execute(sql`INSERT INTO extension_runtime_locks (lock_key) VALUES (${key})`);
    return true;
  });
  expect((await Promise.all([insert("first"), insert("second")])).sort()).toEqual([false, true]);
  expect((await client`SELECT COUNT(*)::int AS count FROM extension_runtime_locks`)[0].count).toBe(2);
});

test("Postgres acquisition waiting on a held row cannot block that holder's effect accounting", async () => {
  const database = drizzle(client);
  let locked!: () => void;
  const admissionLocked = new Promise<void>((resolve) => { locked = resolve; });
  let acquisition: Promise<unknown> | undefined;
  const effect = database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT * FROM extension_runtime_locks WHERE lock_key = 'counter' FOR UPDATE`);
    acquisition = database.transaction(async (contender) => {
      await lockRuntimeAdmission(contender);
      locked();
      await contender.execute(sql`SELECT * FROM extension_runtime_locks WHERE lock_key = 'counter' FOR UPDATE`);
    });
    acquisition.catch(() => undefined);
    await admissionLocked;
    await transaction.execute(sql`UPDATE extension_runtime_locks SET effects = effects + 1 WHERE lock_key = 'counter'`);
  });
  const results = await Promise.allSettled([effect, effect.then(() => acquisition, () => acquisition)]);
  expect(results).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }]);
  expect((await client`SELECT effects FROM extension_runtime_locks WHERE lock_key = 'counter'`)[0].effects).toBe(1);
}, 10_000);
