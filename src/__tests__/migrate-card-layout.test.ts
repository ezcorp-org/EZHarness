/**
 * Integration test — `card_layout` migration is idempotent and
 * PGlite-compatible.
 *
 * Per canvas-dock-sdk.md §5 integration case + plan critical-constraint #1:
 * the migration uses plain `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (NO
 * PL/pgSQL DO blocks) so it works on both PGlite and external Postgres.
 *
 * Cases:
 *   1. Fresh PGlite DB after migrate(): tool_calls.card_layout exists.
 *   2. Re-running migrate(): no-op, schema unchanged.
 */
import { test, expect, describe } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

async function tableHasColumn(db: any, table: string, column: string): Promise<boolean> {
	const rows = (await db.execute(sql.raw(`
		SELECT column_name FROM information_schema.columns
		WHERE table_schema='public' AND table_name='${table}' AND column_name='${column}'
	`))).rows as Array<{ column_name: string }>;
	return rows.length > 0;
}

describe("card_layout migration", () => {
	test("fresh PGlite DB: migrate() adds card_layout to tool_calls", async () => {
		const pglite = new PGlite({ extensions: { vector } });
		await pglite.waitReady;
		const db = drizzle(pglite, { schema });
		try {
			await migrate(db);
			expect(await tableHasColumn(db, "tool_calls", "card_layout")).toBe(true);
			// Sanity: the sibling card_type column from Phase 40 still exists too.
			expect(await tableHasColumn(db, "tool_calls", "card_type")).toBe(true);
		} finally {
			await pglite.close();
		}
	});

	test("idempotent: re-running migrate() is a no-op", async () => {
		const pglite = new PGlite({ extensions: { vector } });
		await pglite.waitReady;
		const db = drizzle(pglite, { schema });
		try {
			await migrate(db);
			// The second run must not throw — a missing IF NOT EXISTS or a
			// PL/pgSQL DO block would explode here on PGlite.
			await migrate(db);
			expect(await tableHasColumn(db, "tool_calls", "card_layout")).toBe(true);
		} finally {
			await pglite.close();
		}
	});
});
