/**
 * The bun-sql (external Postgres) half of the NUL fix, end to end.
 *
 * The incident was on external Postgres, but the NUL regression suite runs on
 * the embedded PGlite driver — which takes a DIFFERENT patch. `patchJsonColumns`
 * is applied with `identityBase: false` for PGlite (keep drizzle's
 * JSON.stringify) and `identityBase: true` for bun-sql (Bun.sql serializes the
 * object itself; stringifying first would double-encode). So a fix proven on
 * PGlite proves nothing about the driver the bug actually happened on: the two
 * paths put different bytes on the wire.
 *
 * This file closes that gap. It maps values through the REAL bun-sql-form
 * patches, serializes the result exactly as Bun.sql does for a bind, and feeds
 * that to a real Postgres engine, asserting the row inserts and reads back.
 *
 * PGlite is used as the engine because it IS Postgres (the same C source
 * compiled to wasm) and rejects NUL identically — verified in this file rather
 * than assumed, since a lenient engine would make every assertion here vacuous.
 * Behaviour was additionally confirmed against a real Postgres 16 server
 * (pgvector/pgvector:pg16) during review: unpatched, `text` fails with
 * `invalid byte sequence for encoding "UTF8": 0x00` and `jsonb` with
 * `unsupported Unicode escape sequence`; patched, both insert and read back.
 */
import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { patchJsonColumns, patchTextColumns } from "../db/nul-column-patch";

const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);

/** The real string from the incident: a NUL embedded in a spawned path. */
const SPAWN_ERROR = `spawn /app/web/.ezcorp/extensions/timezone-time-hi${NUL} /bin ENOENT`;
const SCRUBBED = `spawn /app/web/.ezcorp/extensions/timezone-time-hi${FFFD} /bin ENOENT`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PgJsonb } = await import("drizzle-orm/pg-core/columns/jsonb");
const { PgJson } = await import("drizzle-orm/pg-core/columns/json");
const { PgText } = await import("drizzle-orm/pg-core/columns/text");

// EVERY prototype these patches touch, snapshotted before any of them run.
// `patchJsonColumns` patches PgJson as well as PgJsonb, so restoring only the
// two prototypes this file asserts on would still leak the bun-sql form.
const protos: Array<[string, any]> = [
  ["jsonb", PgJsonb.prototype],
  ["json", PgJson.prototype],
  ["text", PgText.prototype],
];
const pristine = new Map(protos.map(([name, proto]) => [name, proto.mapToDriverValue]));

const mapJsonb = (value: unknown) => (PgJsonb.prototype as any).mapToDriverValue(value);
const mapText = (value: unknown) => (PgText.prototype as any).mapToDriverValue(value);
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * What Bun.sql actually puts on the wire for a jsonb bind.
 *
 * Under the bun-sql patch the column mapper hands the driver a raw JS object
 * (that is the double-encoding fix). Bun.sql then serializes it to JSON itself.
 * Reproducing that step is what makes this an end-to-end test of the bun-sql
 * path rather than a test of the mapper in isolation.
 */
function asBunSqlWireValue(mapped: unknown): string {
  return JSON.stringify(mapped);
}

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.query(`CREATE TABLE wire (id serial PRIMARY KEY, txt text, payload jsonb)`);
});

afterAll(async () => {
  await pg.close();
});

// The prototypes are process-global; leaving the bun-sql form installed would
// change how every later test in this process serializes jsonb.
afterEach(() => {
  for (const [name, proto] of protos) proto.mapToDriverValue = pristine.get(name);
});

async function insert(txt: string | null, payload: string | null): Promise<void> {
  await pg.query(`INSERT INTO wire (txt, payload) VALUES ($1, $2)`, [txt, payload]);
}

describe("the engine really does reject NUL (guards every assertion below)", () => {
  test("an unpatched text bind is refused by Postgres", async () => {
    await expect(insert(SPAWN_ERROR, null)).rejects.toThrow(/invalid byte sequence|0x00/i);
  });

  test("an unpatched jsonb bind is refused by Postgres", async () => {
    await expect(insert(null, JSON.stringify({ error: SPAWN_ERROR }))).rejects.toThrow(
      /unsupported Unicode escape/i,
    );
  });

  test("a NUL in an object KEY is refused too", async () => {
    await expect(insert(null, JSON.stringify({ [`k${NUL}`]: 1 }))).rejects.toThrow(
      /unsupported Unicode escape/i,
    );
  });
});

describe("bun-sql form — values survive the round trip", () => {
  test("a jsonb payload carrying U+0000 inserts and reads back scrubbed", async () => {
    await patchJsonColumns(true);

    const mapped = mapJsonb({
      toolName: "get_time",
      extensionId: "timezone-time",
      error: SPAWN_ERROR,
      duration: 12,
    });
    // The bun-sql patch must still hand the driver an OBJECT — returning a
    // string here is the double-encoding bug this patch also carries.
    expect(typeof mapped).toBe("object");

    await insert(null, asBunSqlWireValue(mapped));

    const rows = await pg.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM wire WHERE payload->>'toolName' = 'get_time'`,
    );
    expect(rows.rows.length).toBe(1);
    const payload = rows.rows[0]!.payload;
    expect(payload.error).toBe(SCRUBBED);
    expect(String(payload.error).includes(NUL)).toBe(false);
    // `->>` still resolves, i.e. this was stored as a jsonb OBJECT and not as a
    // jsonb string scalar.
    expect(payload.duration).toBe(12);
  });

  test("a text column carrying U+0000 inserts and reads back scrubbed", async () => {
    await patchTextColumns();

    const mapped = mapText(SPAWN_ERROR) as string;
    await insert(mapped, null);

    const rows = await pg.query<{ txt: string }>(
      `SELECT txt FROM wire WHERE txt IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    expect(rows.rows[0]!.txt).toBe(SCRUBBED);
    expect(rows.rows[0]!.txt.includes(NUL)).toBe(false);
  });

  test("a NUL in an object KEY inserts and reads back scrubbed", async () => {
    await patchJsonColumns(true);

    await insert(null, asBunSqlWireValue(mapJsonb({ [`bad${NUL}key`]: "v" })));

    const rows = await pg.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM wire WHERE payload ? ${"$1"}`,
      [`bad${FFFD}key`],
    );
    expect(rows.rows.length).toBe(1);
    expect(Object.keys(rows.rows[0]!.payload)).toEqual([`bad${FFFD}key`]);
  });

  test("a clean payload is unaffected — no double-encode, no rewrite", async () => {
    await patchJsonColumns(true);

    const clean = { toolName: "clean_tool", nested: { list: ["a", "b"], n: 1 } };
    // Identity: the scrubber must not clone a clean value on the hot path.
    expect(mapJsonb(clean)).toBe(clean);

    await insert(null, asBunSqlWireValue(mapJsonb(clean)));

    const rows = await pg.query<{ payload: typeof clean }>(
      `SELECT payload FROM wire WHERE payload->>'toolName' = 'clean_tool'`,
    );
    expect(rows.rows[0]!.payload).toEqual(clean);
  });

  test("an escaped \\u0000 is stored verbatim, not treated as a NUL", async () => {
    await patchJsonColumns(true);
    await patchTextColumns();

    const escaped = "literal \\u0000 sequence";
    await insert(mapText(escaped) as string, asBunSqlWireValue(mapJsonb({ code: escaped })));

    const rows = await pg.query<{ txt: string; payload: { code: string } }>(
      `SELECT txt, payload FROM wire WHERE txt LIKE 'literal%'`,
    );
    expect(rows.rows[0]!.txt).toBe(escaped);
    expect(rows.rows[0]!.payload.code).toBe(escaped);
  });
});
