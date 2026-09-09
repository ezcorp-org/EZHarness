import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { finalizeRunRow, terminalizeOrphanedRuns } from "../db/queries/runs";
import { runs } from "../db/schema";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function insert(status: "running" | "success" = "running") {
  const id = crypto.randomUUID();
  await getTestDb().insert(runs).values({ id, agentName: "test", status, startedAt: new Date(), result: { success: true, output: "partial" } });
  return id;
}
async function stored(id: string) {
  return (await getTestDb().select().from(runs).where(eq(runs.id, id)))[0]!;
}
test("terminalizes running row with finished time and error", async () => {
  const id = await insert();
  expect(await finalizeRunRow(id, "error", "Watchdog")).toBe(1);
  expect(await stored(id)).toMatchObject({ status: "error", finishedAt: expect.any(Date), result: { success: false, output: null, error: "Watchdog" } });
});
test("cancellation without error preserves partial result", async () => {
  const id = await insert();
  expect(await finalizeRunRow(id, "cancelled")).toBe(1);
  expect(await stored(id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date), result: { success: true, output: "partial" } });
});
test("already terminal row is not overwritten", async () => {
  const id = await insert("success");
  expect(await finalizeRunRow(id, "error", "late")).toBe(0);
  expect(await stored(id)).toMatchObject({ status: "success", result: { success: true, output: "partial" } });
});
test("boot drains every unfinished running row", async () => {
  const ids = await Promise.all([insert(), insert(), insert()]);
  expect(await terminalizeOrphanedRuns()).toBe(3);
  for (const id of ids) expect(await stored(id)).toMatchObject({ status: "error", finishedAt: expect.any(Date), result: { error: "Run orphaned: process restarted while run was active" } });
});
test("clean boot drains no rows", async () => {
  expect(await terminalizeOrphanedRuns()).toBe(0);
});
