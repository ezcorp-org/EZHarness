/**
 * Suite for the drizzle column-prototype patches that carry the NUL (U+0000)
 * scrubber onto every write.
 *
 * These call the REAL production patches (src/db/nul-column-patch.ts) against
 * the REAL drizzle column classes — not a re-declared local copy — so deleting
 * or breaking a patch during a drizzle upgrade fails here. Each test restores
 * the pristine prototypes afterwards; the prototypes are process-global shared
 * state.
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
  patchJsonColumns,
  patchTextColumns,
  applyPgliteNulPatches,
} from "../db/nul-column-patch";

const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);

const { PgJsonb } = await import("drizzle-orm/pg-core/columns/jsonb");
const { PgJson } = await import("drizzle-orm/pg-core/columns/json");
const { PgText } = await import("drizzle-orm/pg-core/columns/text");

/* eslint-disable @typescript-eslint/no-explicit-any */
const protos: Array<[string, any]> = [
  ["jsonb", PgJsonb.prototype],
  ["json", PgJson.prototype],
  ["text", PgText.prototype],
];

// Snapshot the pristine mappers once, before any patch runs.
const pristine = new Map(protos.map(([name, proto]) => [name, proto.mapToDriverValue]));

function restore() {
  for (const [name, proto] of protos) proto.mapToDriverValue = pristine.get(name);
}

function mapJsonb(value: unknown): unknown {
  return (PgJsonb.prototype as any).mapToDriverValue(value);
}
function mapText(value: unknown): unknown {
  return (PgText.prototype as any).mapToDriverValue(value);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

afterEach(restore);

describe("patchJsonColumns — PGlite form (identityBase false)", () => {
  test("keeps drizzle's JSON.stringify base and scrubs NULs", async () => {
    await patchJsonColumns(false);
    const out = mapJsonb({ error: `boom${NUL}` });
    // Still serialized (PGlite needs the string form) …
    expect(typeof out).toBe("string");
    // … and the NUL is gone, so Postgres will accept it.
    expect(out).toBe(JSON.stringify({ error: `boom${FFFD}` }));
    expect(String(out).includes(NUL)).toBe(false);
  });

  test("patches PgJson as well as PgJsonb", async () => {
    await patchJsonColumns(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (PgJson.prototype as any).mapToDriverValue({ k: `v${NUL}` });
    expect(out).toBe(JSON.stringify({ k: `v${FFFD}` }));
  });

  test("a clean value serializes exactly as drizzle would unpatched", async () => {
    const clean = { a: 1, b: "two" };
    const before = pristine.get("jsonb")!.call(PgJsonb.prototype, clean);
    await patchJsonColumns(false);
    expect(mapJsonb(clean)).toBe(before);
  });
});

describe("patchJsonColumns — bun-sql form (identityBase true)", () => {
  test("returns the raw object (no double-encode) and scrubs NULs", async () => {
    await patchJsonColumns(true);
    const out = mapJsonb({ error: `boom${NUL}` });
    expect(typeof out).toBe("object");
    expect(out).toEqual({ error: `boom${FFFD}` });
  });

  test("preserves object IDENTITY for a clean value", async () => {
    await patchJsonColumns(true);
    const clean = { foo: "bar", n: 42 };
    // The pre-existing double-encoding fix depends on this staying identity.
    expect(mapJsonb(clean)).toBe(clean);
    expect(mapJsonb(clean)).not.toBe(JSON.stringify(clean));
  });
});

describe("patchTextColumns", () => {
  test("scrubs a NUL bound to a text column", async () => {
    await patchTextColumns();
    expect(mapText(`stack${NUL}trace`)).toBe(`stack${FFFD}trace`);
  });

  test("leaves a clean string at its original identity", async () => {
    await patchTextColumns();
    const clean = "ordinary value";
    expect(mapText(clean)).toBe(clean);
  });

  test("passes non-string bindings straight through", async () => {
    await patchTextColumns();
    expect(mapText(null)).toBeNull();
    expect(mapText(7)).toBe(7);
  });
});

describe("idempotency — patches re-derive from the pristine base", () => {
  test("applying the PGlite json patch twice does not double-encode", async () => {
    await patchJsonColumns(false);
    const once = mapJsonb({ a: `x${NUL}` });
    await patchJsonColumns(false);
    const twice = mapJsonb({ a: `x${NUL}` });
    expect(twice).toBe(once);
    // A double-wrap would JSON.stringify the already-stringified form.
    expect(twice).toBe(JSON.stringify({ a: `x${FFFD}` }));
  });

  test("applying the text patch twice scrubs exactly once", async () => {
    await patchTextColumns();
    await patchTextColumns();
    expect(mapText(`a${NUL}b`)).toBe(`a${FFFD}b`);
  });

  test("switching bun-sql form then back to PGlite form restores serialization", async () => {
    await patchJsonColumns(true);
    expect(typeof mapJsonb({ a: 1 })).toBe("object");
    await patchJsonColumns(false);
    expect(mapJsonb({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("applyPgliteNulPatches", () => {
  test("installs BOTH the json and text scrubbers in one call", async () => {
    await applyPgliteNulPatches();
    expect(mapJsonb({ e: `x${NUL}` })).toBe(JSON.stringify({ e: `x${FFFD}` }));
    expect(mapText(`y${NUL}`)).toBe(`y${FFFD}`);
  });
});
