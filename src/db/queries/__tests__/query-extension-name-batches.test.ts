/**
 * Batch name lookups behind the author page's "Your installations" list.
 *
 * The list used to print a raw installation id per row. Naming every row means
 * answering "what is this installation called" for a WHOLE list, so both
 * lookups here are single round-trips keyed by id:
 *  - `getReleaseNamesByInstallationIds` reads the reserved active-release name;
 *  - `getExtensionsByIds` reads the legacy `extensions` row a bundled
 *    installation shares its id with.
 *
 * Pinned here: missing ids stay absent (never guessed), duplicate ids collapse
 * to one round-trip, empty input performs NO query at all, and the id lookup
 * deliberately keeps uninstalled rows that `getExtensionsByNames` filters out.
 */
import { test, expect, describe, beforeEach, afterAll, spyOn } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

import { sql } from "drizzle-orm";
import { extensions } from "../../schema";
import { getExtensionsByIds, getExtensionsByNames } from "../extensions";
import { getReleaseNamesByInstallationIds } from "../extension-releases";

const LIVE = "install-live";
const BUNDLED = "install-bundled";
const GONE = "install-uninstalled";

function legacyRow(id: string, name: string) {
  return {
    id,
    name,
    version: "0.0.1",
    description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {}, entrypoint: "./e.ts", tools: [] },
    source: "bundled",
  };
}

async function seed() {
  const db = getTestDb();
  await db.insert(extensions).values([legacyRow(BUNDLED, "lessons-distiller"), legacyRow(GONE, "retired-extension")] as never);
  for (const [id, uninstalled] of [[LIVE, false], [BUNDLED, false], [GONE, true]] as const) {
    await db.execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES (${id}, ${"owner"}, ${"global"}, ${JSON.stringify({ id, uninstalled })})`);
  }
  await db.execute(sql`INSERT INTO extension_release_names (name, installation_id) VALUES (${"memory-extractor"}, ${LIVE})`);
}

beforeEach(async () => {
  await setupTestDb();
  await seed();
});
afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("getReleaseNamesByInstallationIds", () => {
  test("names every installation that reserved one and omits the rest", async () => {
    const names = await getReleaseNamesByInstallationIds([LIVE, BUNDLED, "install-absent"]);
    expect(names.get(LIVE)).toBe("memory-extractor");
    expect(names.has(BUNDLED)).toBe(false);
    expect(names.has("install-absent")).toBe(false);
    expect(names.size).toBe(1);
  });

  test("repeated ids collapse into a single round-trip", async () => {
    const execute = spyOn(getTestDb(), "execute");
    try {
      expect(await getReleaseNamesByInstallationIds([LIVE, LIVE, LIVE])).toEqual(new Map([[LIVE, "memory-extractor"]]));
      expect(execute).toHaveBeenCalledTimes(1);
      expect(String(execute.mock.calls[0]?.[0])).not.toContain(LIVE);
    } finally {
      execute.mockRestore();
    }
  });

  test("an empty id list queries nothing", async () => {
    const execute = spyOn(getTestDb(), "execute");
    try {
      expect(await getReleaseNamesByInstallationIds([])).toEqual(new Map());
      expect(execute).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
    }
  });
});

describe("getExtensionsByIds", () => {
  test("returns the legacy row of every known id and omits unknown ids", async () => {
    const rows = await getExtensionsByIds([BUNDLED, "ext-absent"]);
    expect(rows.get(BUNDLED)?.name).toBe("lessons-distiller");
    expect(rows.has("ext-absent")).toBe(false);
    expect(rows.size).toBe(1);
  });

  test("keeps an uninstalled row that the name lookup filters out", async () => {
    expect((await getExtensionsByIds([GONE])).get(GONE)?.name).toBe("retired-extension");
    expect(await getExtensionsByNames(["retired-extension"])).toEqual(new Map());
  });

  test("repeated ids collapse into a single round-trip", async () => {
    const select = spyOn(getTestDb(), "select");
    try {
      expect([...(await getExtensionsByIds([BUNDLED, BUNDLED]))].map(([id]) => id)).toEqual([BUNDLED]);
      expect(select).toHaveBeenCalledTimes(1);
    } finally {
      select.mockRestore();
    }
  });

  test("an empty id list queries nothing", async () => {
    const select = spyOn(getTestDb(), "select");
    try {
      expect(await getExtensionsByIds([])).toEqual(new Map());
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });
});
