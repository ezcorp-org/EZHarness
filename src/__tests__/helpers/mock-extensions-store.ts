/**
 * Shared in-memory fake for `src/db/queries/extensions`.
 *
 * WHY THIS EXISTS
 * ────────────────
 * ~90 backend test files each hand-rolled their own copy of a Map-backed
 * fake for getExtensionByName / createExtension / listExtensions /
 * updateExtension / deleteExtension / incrementFailures / resetFailures /
 * disableExtension. The copies had already drifted — some rows carried
 * `installedPermissions`/`version`, some didn't; some `deleteExtension`s
 * actually deleted, some were deliberate no-ops; at least one file's own
 * comment admitted it "mirrors bundled-critical-s9.test.ts" byte-for-byte.
 * This is the one shared implementation.
 *
 * `../../db/queries/extensions` is already in mock-cleanup.ts's
 * MODULE_PATHS, so any `mock.module("../db/queries/extensions", () => ({
 * ...store }))` built from this helper is restored to the real module by
 * `restoreModuleMocks()` in `afterAll` — every migrated file must still
 * call that itself; this helper does not register anything globally.
 *
 * TWO KEYING CONVENTIONS, ONE IMPLEMENTATION
 * ───────────────────────────────────────────
 * The population split cleanly into two families:
 *   - the bundled-extension family seeds/reads its Map by NAME
 *     (`store.set(name, row)`, `store.get("task-tracking")`) with a
 *     sequential `ext-${n}` id;
 *   - the installer/cli-ext family seeds/reads its Map by ID
 *     (`mockExtensions.set(ext.id, ext)`) with `crypto.randomUUID()`.
 * `keyBy` picks which one `.store` is keyed by; every function's
 * observable behavior is identical either way (id-based ops like
 * `updateExtension`/`deleteExtension` scan by id regardless of `keyBy`,
 * matching what both hand-rolled families already did). This means a
 * migrated file's own seed/assert helpers keep working with a plain
 * `store` → `extStore.store` rename — no restructuring of the call sites.
 *
 * `listExtensions` intentionally ignores its `enabledOnly`/`bundled`
 * filter args (returns everything), matching EVERY hand-rolled fake in
 * the population — none of them implemented real filtering, so making
 * this one filter for real would be a behavior change, not a pure
 * refactor. `createExtension`/`updateExtension` don't stamp
 * `createdAt`/`updatedAt` unless `timestamps: true` is passed, for the
 * same reason (the bundled family never set them; the installer family
 * always did).
 *
 * Matches the house style of test-pglite.ts's `mockDbConnection()`: call
 * the factory once at module scope (before the imports that touch the
 * mocked module), wire the returned functions into `mock.module()`, and
 * call `.reset()` from `beforeEach`.
 */
import type { ExtensionManifestV2, ExtensionPermissions } from "../../extensions/types";

/** Superset of every field a call site in the population reads or writes.
 *  Extra fields beyond what a given test needs are harmless — they just
 *  never get read.
 *
 *  `manifest`/`grantedPermissions` are REQUIRED and typed against the REAL
 *  domain types (not `unknown`) because the hand-rolled fakes this helper
 *  replaces overwhelmingly typed them that way too (`manifest: unknown` +
 *  `grantedPermissions: ExtensionPermissions`, both required, in nearly
 *  every `StoredExtension` interface in the population) — the population's
 *  own test bodies chain straight off them (`row.grantedPermissions.network`,
 *  `row.manifest.permissions`) with no cast. `Partial<ExtensionManifestV2>`
 *  (rather than the full type) because plenty of seed fixtures build a
 *  deliberately incomplete manifest. The couple of call sites that never
 *  model either field just pass a trivial `{ grantedAt: {} }` / `{}`. */
export interface MockExtensionRow {
  id: string;
  name: string;
  description?: string;
  manifest: Partial<ExtensionManifestV2>;
  installPath?: string | null;
  source?: string | null;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  installedPermissions?: ExtensionPermissions;
  version?: string;
  consecutiveFailures?: number;
  checksumVerified?: boolean;
  creatorUserId?: string | null;
  modifiable?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export interface MockExtensionsStoreOptions {
  /** What `.store` is keyed by. "name" mirrors the bundled-extension test
   *  family; "id" (the real table's primary key) mirrors the installer/
   *  cli-ext family. Default: "id". */
  keyBy?: "id" | "name";
  /** Stamp `createdAt`/`updatedAt` Date objects on create/update — the
   *  installer family's fixtures build these; the bundled family's don't.
   *  Default: false. */
  timestamps?: boolean;
  /** id generator for `createExtension` when the payload doesn't carry one.
   *  Default: sequential `ext-1`, `ext-2`, … (the bundled family's
   *  convention). Pass `() => crypto.randomUUID()` for the installer
   *  family's. */
  generateId?: () => string;
}

export interface MockExtensionsStore {
  /** The backing Map, keyed per `keyBy` — exposed directly (not a getter)
   *  so a migrated file's own seed/assert helpers can keep doing
   *  `extStore.store.set(...)` / `.get(...)` exactly as they did before
   *  migration. Stable for the lifetime of this store; `reset()` clears
   *  it in place rather than replacing it. */
  readonly store: Map<string, MockExtensionRow>;
  /** Clear all rows and reset the id counter. Call from `beforeEach`. */
  reset(): void;
  /** Insert a hand-built fixture row directly (bypassing `createExtension`'s
   *  id generation/timestamp stamping), filling `manifest`/`grantedPermissions`/
   *  `enabled` with trivial defaults when the caller doesn't care about them.
   *  This is the one seeding path every test that pokes rows into the store
   *  by hand should use — it's what keeps `manifest: {}, grantedPermissions:
   *  { grantedAt: {} }` boilerplate from creeping back into call sites the
   *  way it did in each file's original hand-rolled fake. Returns the full
   *  row (with defaults applied) for immediate use. */
  seed(row: Partial<MockExtensionRow> & { id: string; name: string }): MockExtensionRow;
  getExtension(id: string): Promise<MockExtensionRow | null>;
  getExtensionByName(name: string): Promise<MockExtensionRow | null>;
  getExtensionsByNames(names: string[]): Promise<Map<string, MockExtensionRow>>;
  listExtensions(
    opts?: boolean | { enabledOnly?: boolean; bundled?: boolean },
  ): Promise<MockExtensionRow[]>;
  createExtension(data: Partial<MockExtensionRow> & { name: string }): Promise<MockExtensionRow>;
  updateExtension(id: string, patch: Partial<MockExtensionRow>): Promise<MockExtensionRow | null>;
  deleteExtension(id: string): Promise<boolean>;
  incrementFailures(id: string): Promise<number>;
  resetFailures(id: string): Promise<void>;
  disableExtension(id: string): Promise<void>;
}

/**
 * Narrow an optional value (a `store.get(...)`/`.find(...)` result, or an
 * optional field on a row) to definite, for the common case where a test
 * has just seeded/mutated the row and knows it must be present. Throws with
 * a real message instead of a silent `!` — a bare `!` swallows the actual
 * failure mode (row genuinely missing) into an opaque "Cannot read
 * properties of undefined" several lines later, whereas this fails at the
 * point of the wrong assumption with the row/field name attached. Prefer
 * `expect(x).toBeDefined()` where the missing-ness IS the thing under test
 * (that's a real assertion); reach for this where presence is a setup
 * precondition the test doesn't otherwise need to assert on.
 */
export function requireRow<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be present, got ${value}`);
  }
  return value;
}

export function createMockExtensionsStore(
  options: MockExtensionsStoreOptions = {},
): MockExtensionsStore {
  const keyBy = options.keyBy ?? "id";
  const timestamps = options.timestamps ?? false;
  let nextId = 0;
  const generateId = options.generateId ?? (() => `ext-${++nextId}`);

  const store = new Map<string, MockExtensionRow>();

  function reset(): void {
    store.clear();
    nextId = 0;
  }

  function keyFor(row: MockExtensionRow): string {
    return keyBy === "name" ? row.name : row.id;
  }

  function seed(row: Partial<MockExtensionRow> & { id: string; name: string }): MockExtensionRow {
    const full: MockExtensionRow = {
      manifest: {},
      grantedPermissions: { grantedAt: {} },
      enabled: true,
      ...row,
    };
    store.set(keyFor(full), full);
    return full;
  }

  /** Id-based lookup regardless of `keyBy` — mirrors the `for (const row of
   *  store.values()) if (row.id === id)` scan every name-keyed hand-rolled
   *  fake used for updateExtension/deleteExtension/etc. */
  function findById(id: string): MockExtensionRow | undefined {
    if (keyBy === "id") return store.get(id);
    for (const row of store.values()) if (row.id === id) return row;
    return undefined;
  }

  async function getExtension(id: string): Promise<MockExtensionRow | null> {
    return findById(id) ?? null;
  }

  async function getExtensionByName(name: string): Promise<MockExtensionRow | null> {
    if (keyBy === "name") return store.get(name) ?? null;
    for (const row of store.values()) if (row.name === name) return row;
    return null;
  }

  async function getExtensionsByNames(names: string[]): Promise<Map<string, MockExtensionRow>> {
    const out = new Map<string, MockExtensionRow>();
    if (names.length === 0) return out;
    const wanted = new Set(names);
    for (const row of store.values()) if (wanted.has(row.name)) out.set(row.name, row);
    return out;
  }

  // Deliberately ignores `opts` — see the file header. Every hand-rolled
  // fake in the population returned everything regardless of args.
  async function listExtensions(
    _opts?: boolean | { enabledOnly?: boolean; bundled?: boolean },
  ): Promise<MockExtensionRow[]> {
    return Array.from(store.values());
  }

  async function createExtension(
    data: Partial<MockExtensionRow> & { name: string },
  ): Promise<MockExtensionRow> {
    const id = data.id ?? generateId();
    const row = {
      ...data,
      id,
      ...(timestamps ? { createdAt: new Date(), updatedAt: new Date() } : {}),
    } as MockExtensionRow;
    store.set(keyFor(row), row);
    return row;
  }

  async function updateExtension(
    id: string,
    patch: Partial<MockExtensionRow>,
  ): Promise<MockExtensionRow | null> {
    const row = findById(id);
    if (!row) return null;
    Object.assign(row, patch, timestamps ? { updatedAt: new Date() } : {});
    return row;
  }

  async function deleteExtension(id: string): Promise<boolean> {
    for (const [k, v] of store) {
      if (v.id === id) {
        store.delete(k);
        return true;
      }
    }
    return false;
  }

  async function incrementFailures(id: string): Promise<number> {
    const row = findById(id);
    if (!row) return 0;
    row.consecutiveFailures = (row.consecutiveFailures ?? 0) + 1;
    return row.consecutiveFailures;
  }

  async function resetFailures(id: string): Promise<void> {
    const row = findById(id);
    if (row) row.consecutiveFailures = 0;
  }

  async function disableExtension(id: string): Promise<void> {
    const row = findById(id);
    if (row) row.enabled = false;
  }

  return {
    store,
    reset,
    seed,
    getExtension,
    getExtensionByName,
    getExtensionsByNames,
    listExtensions,
    createExtension,
    updateExtension,
    deleteExtension,
    incrementFailures,
    resetFailures,
    disableExtension,
  };
}
