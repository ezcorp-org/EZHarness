import { describe, expect, test } from "bun:test";
import { embeddedDatabasePath, embeddedStateDir } from "../db/data-path";

describe("embedded database paths", () => {
  test("uses the configured embedded database and its parent", () => {
    const env = { EZCORP_DB_PATH: "/owned/data/ezcorp", HOME: "/home/app" };
    expect(embeddedDatabasePath(env)).toBe("/owned/data/ezcorp");
    expect(embeddedStateDir(env)).toBe("/owned/data");
  });

  test("keeps a relative configured path unchanged and derives its relative parent", () => {
    const env = { EZCORP_DB_PATH: "state/ezcorp", HOME: "/home/app" };
    expect(embeddedDatabasePath(env)).toBe("state/ezcorp");
    expect(embeddedStateDir(env)).toBe("state");
  });

  test("uses a stable home-relative data directory when no path is configured", () => {
    const env = { HOME: "/home/app" };
    expect(embeddedDatabasePath(env)).toBe("/home/app/ez-corp/.data/ez-corp-db");
    expect(embeddedStateDir(env)).toBe("/home/app/ez-corp/.data");
  });

  test("corrects a missing HOME without creating a literal undefined path", () => {
    expect(embeddedDatabasePath({})).toBe(`${process.cwd()}/ez-corp/.data/ez-corp-db`);
    expect(embeddedStateDir({})).toBe(`${process.cwd()}/ez-corp/.data`);
  });

  test("keeps a configured durable path when relational data uses external Postgres", () => {
    const env = { DATABASE_URL: "postgres://db.example/ezcorp", EZCORP_DB_PATH: "/owned/data/ezcorp", HOME: "/home/app" };
    expect(embeddedDatabasePath(env)).toBe("/owned/data/ezcorp");
    expect(embeddedStateDir(env)).toBe("/owned/data");
  });

  test("does not place in-memory database caches in the current package directory", () => {
    expect(embeddedStateDir({ EZCORP_DB_PATH: ":memory:", HOME: "/home/app" })).toBe("/home/app/ez-corp/.data");
  });
});
