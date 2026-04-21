import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, restoreFetch } from "./helpers/test-pglite";
import type { AgentEvents } from "../types";

// Re-establish real settings implementation — parallel tests mock this globally in Bun.
function mockSettingsReal() {
  mock.module("../db/queries/settings", () => {
    const { eq } = require("drizzle-orm");
    const { settings: tbl } = require("../db/schema");
    return {
      async getAllSettings() {
        const { getDb } = require("../db/connection");
        const rows = await getDb().select().from(tbl);
        return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
      },
      async getSetting(key: string) {
        const { getDb } = require("../db/connection");
        const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
        return rows[0]?.value;
      },
      async upsertSetting(key: string, value: unknown) {
        const { getDb } = require("../db/connection");
        const db = getDb();
        const rows = await db.select().from(tbl).where(eq(tbl.key, key));
        if (rows[0]) {
          await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
        } else {
          await db.insert(tbl).values({ key, value, updatedAt: new Date() });
        }
      },
      async deleteSetting(key: string) {
        const { getDb } = require("../db/connection");
        const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
        if (!rows[0]) return false;
        await getDb().delete(tbl).where(eq(tbl.key, key));
        return true;
      },
      async isListingInstalled(listingId: string) {
        const { getDb } = require("../db/connection");
        const { sql } = require("drizzle-orm");
        const [row] = await getDb()
          .select({ count: sql`count(*)::int` })
          .from(tbl)
          .where(sql`${tbl.key} LIKE 'marketplace:installed:%' AND ${tbl.value}->>'listingId' = ${listingId}`);
        return (row?.count ?? 0) > 0;
      },
    };
  });
}

mockSettingsReal();
mockDbConnection();

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;

beforeAll(async () => {
  restoreFetch();
  mockDbConnection();
  mockSettingsReal();
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startTestServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  restoreModuleMocks();
  server?.stop(true);
  await closeTestDb();
});

beforeEach(() => {
  restoreFetch();
  mockDbConnection();
  mockSettingsReal();
});

describe("GET /api/settings", () => {
  test("returns JSON object", async () => {
    const res = await fetch(`${baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
  });
});

describe("PUT /api/settings/:key", () => {
  test("creates a new setting", async () => {
    const res = await fetch(`${baseUrl}/api/settings/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "anthropic" }),
    });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/settings`);
    const settings = await getRes.json() as any;
    expect(settings.provider).toBe("anthropic");
  });

  test("updates an existing setting", async () => {
    await fetch(`${baseUrl}/api/settings/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "opus" }),
    });

    const res = await fetch(`${baseUrl}/api/settings/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sonnet" }),
    });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/settings`);
    const settings = await getRes.json() as any;
    expect(settings.model).toBe("sonnet");
  });

  test("returns 400 when value is missing", async () => {
    const res = await fetch(`${baseUrl}/api/settings/bad`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("stores complex JSON values", async () => {
    const complex = { nested: { key: "val" }, arr: [1, 2, 3] };
    await fetch(`${baseUrl}/api/settings/complex`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: complex }),
    });

    const getRes = await fetch(`${baseUrl}/api/settings`);
    const settings = await getRes.json() as any;
    expect(settings.complex).toEqual(complex);
  });
});

describe("DELETE /api/settings/:key", () => {
  test("deletes an existing setting", async () => {
    await fetch(`${baseUrl}/api/settings/to-delete`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "temp" }),
    });

    const res = await fetch(`${baseUrl}/api/settings/to-delete`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/settings`);
    const settings = await getRes.json() as any;
    expect(settings["to-delete"]).toBeUndefined();
  });

  test("returns 404 for non-existent key", async () => {
    const res = await fetch(`${baseUrl}/api/settings/nonexistent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
