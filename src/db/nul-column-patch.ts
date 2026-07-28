/**
 * Installs the NUL (U+0000) scrubber onto drizzle's column prototypes.
 *
 * WHY A PROTOTYPE PATCH. Postgres cannot store U+0000 in `text` or `jsonb`, and
 * a single one anywhere in a value aborts the entire INSERT (see
 * `./sanitize-nul.ts` for the incident this comes from). The values that carry
 * NULs are tool- and subprocess-derived, so they can surface in almost any
 * write. Sanitizing at ~45 individual query modules would be a rule every
 * future call site has to remember; patching the column's `mapToDriverValue`
 * puts it on the one path every drizzle write already takes, for every table,
 * forever.
 *
 * `schema.ts` declares only `text()` and `jsonb()` columns (368 and 46; no
 * varchar/char/json), so `PgText` + `PgJsonb`/`PgJson` covers every
 * string-bearing column in the schema.
 *
 * This lives in its own module rather than in `connection.ts` because the test
 * suite mocks `db/connection` wholesale (`mockDbConnection()`); the test PGlite
 * helper needs to apply these same real patches without tripping over that
 * mock.
 */
import { sanitizeNulDeep } from "./sanitize-nul";

/** A drizzle column's `mapToDriverValue`. `this` is the column instance. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DriverValueMapper = (this: any, value: unknown) => unknown;

/**
 * Pristine (unpatched) `mapToDriverValue` per column prototype, captured the
 * first time we patch it. Every patch is re-derived from the pristine base
 * rather than from whatever is currently installed, which makes the patches
 * idempotent: applying them twice — or again after a test restores a
 * prototype — can never double-wrap the sanitizer or stack an identity
 * override onto an identity override.
 */
const pristineMappers = new WeakMap<object, DriverValueMapper>();

function pristineMapper(proto: object): DriverValueMapper {
  const existing = pristineMappers.get(proto);
  if (existing) return existing;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = (proto as any).mapToDriverValue as DriverValueMapper;
  pristineMappers.set(proto, original);
  return original;
}

const identity: DriverValueMapper = (value: unknown) => value;

/**
 * Install `mapToDriverValue = base(sanitizeNulDeep(value))` on a column
 * prototype.
 *
 * `identityBase` selects what runs after the scrub: drizzle's own pristine
 * serializer (the default, correct for PGlite and for `text`), or identity —
 * which bun-sql requires for jsonb, because Bun.sql serializes JS objects
 * itself and drizzle's `JSON.stringify` would double-encode them.
 */
function patchColumnMapper(proto: object, identityBase: boolean): void {
  const base = identityBase ? identity : pristineMapper(proto);
  // `any` cast is deliberate: monkey-patching drizzle's private
  // `mapToDriverValue` on the column-type prototype; there's no public type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proto as any).mapToDriverValue = function (this: unknown, value: unknown) {
    return base.call(this, sanitizeNulDeep(value));
  };
}

/**
 * Patch `jsonb` + `json` columns.
 *
 * `identityBase: true` is the bun-sql (external Postgres) form — it also
 * carries the pre-existing double-encoding fix. `false` is the PGlite form,
 * which keeps drizzle's `JSON.stringify` base; swapping identity in there would
 * hand PGlite a raw object and break every jsonb write.
 */
export async function patchJsonColumns(identityBase: boolean): Promise<void> {
  const [{ PgJsonb }, { PgJson }] = await Promise.all([
    import("drizzle-orm/pg-core/columns/jsonb"),
    import("drizzle-orm/pg-core/columns/json"),
  ]);
  patchColumnMapper(PgJsonb.prototype, identityBase);
  patchColumnMapper(PgJson.prototype, identityBase);
}

/**
 * Patch `text` columns.
 *
 * Text needs no driver-specific serialization (drizzle's base mapper is
 * identity), so the scrub is the entire patch and both drivers share it.
 *
 * This is the half that keeps failure reporting alive: `persistError` writes
 * `err.stack` into a text column, and `err.stack` embeds the very message that
 * carried the NUL — so before this, the handler meant to make a failed
 * `tool_calls` insert observable died the same silent death as the insert it
 * was reporting.
 */
export async function patchTextColumns(): Promise<void> {
  const { PgText } = await import("drizzle-orm/pg-core/columns/text");
  patchColumnMapper(PgText.prototype, false);
}

/** Apply every scrubber for the embedded-PGlite driver. */
export async function applyPgliteNulPatches(): Promise<void> {
  await patchJsonColumns(false);
  await patchTextColumns();
}
