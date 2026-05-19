import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
  isListingInstalled,
} = await import("../db/queries/settings");

describe("settings queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("upsertSetting inserts new key", async () => {
    await upsertSetting("theme", "dark");
    expect(await getSetting("theme")).toBe("dark");
  });

  test("upsertSetting updates existing key in place", async () => {
    await upsertSetting("theme", "dark");
    await upsertSetting("theme", "light");
    expect(await getSetting("theme")).toBe("light");
    // Only one row total for that key
    const all = await getAllSettings();
    expect(Object.keys(all).filter((k) => k === "theme").length).toBe(1);
  });

  test("upsertSetting accepts JSON values", async () => {
    await upsertSetting("config", { provider: "anthropic", maxTokens: 2048 });
    expect(await getSetting("config")).toEqual({
      provider: "anthropic",
      maxTokens: 2048,
    });
  });

  test("getSetting returns undefined for missing key", async () => {
    expect(await getSetting("ghost")).toBeUndefined();
  });

  test("getAllSettings returns map of every key", async () => {
    await upsertSetting("a", 1);
    await upsertSetting("b", "two");
    await upsertSetting("c", { nested: true });

    const all = await getAllSettings();
    expect(all.a).toBe(1);
    expect(all.b).toBe("two");
    expect(all.c).toEqual({ nested: true });
  });

  test("getAllSettings returns empty object when no settings", async () => {
    expect(await getAllSettings()).toEqual({});
  });

  test("deleteSetting removes the key, returns false on second call", async () => {
    await upsertSetting("temp", "x");
    expect(await deleteSetting("temp")).toBe(true);
    expect(await getSetting("temp")).toBeUndefined();
    expect(await deleteSetting("temp")).toBe(false);
  });

  test("deleteSetting returns false for missing key", async () => {
    expect(await deleteSetting("never-existed")).toBe(false);
  });

  test("isListingInstalled returns false when no marketplace settings exist", async () => {
    expect(await isListingInstalled("listing-123")).toBe(false);
  });

  test("isListingInstalled detects matching marketplace install record", async () => {
    await upsertSetting("marketplace:installed:abc", { listingId: "listing-123", version: "1.0.0" });
    expect(await isListingInstalled("listing-123")).toBe(true);
    expect(await isListingInstalled("listing-other")).toBe(false);
  });
});
