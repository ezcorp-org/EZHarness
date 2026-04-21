import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock DB layer ────────────────────────────────────────────────────

let mockRows: any[] = [];
let lastInsertValues: any = null;
let lastDeleteWhere: any = null;
let shouldThrow = false;

function resetMockState() {
  mockRows = [];
  lastInsertValues = null;
  lastDeleteWhere = null;
  shouldThrow = false;
}

function createChainableDb() {
  const chain: any = {
    _op: null,
    insert: (_table: any) => {
      chain._op = "insert";
      return chain;
    },
    values: (vals: any) => {
      if (shouldThrow) throw new Error("DB unavailable");
      lastInsertValues = vals;
      return chain;
    },
    select: () => {
      chain._op = "select";
      return chain;
    },
    from: (_table: any) => {
      // Make from() thenable for select().from() without where/orderBy (e.g. countErrors)
      const result = Object.create(chain);
      result.then = (r: any, j?: any) => Promise.resolve(mockRows).then(r, j);
      return result;
    },
    delete: (_table: any) => {
      chain._op = "delete";
      return chain;
    },
    where: (args: any) => {
      if (chain._op === "delete") lastDeleteWhere = args;
      return chain;
    },
    orderBy: (..._args: any[]) => {
      return {
        limit: (_n: any) => ({
          offset: (_o: any) => ({
            then: (r: any, j?: any) => Promise.resolve(mockRows).then(r, j),
          }),
          then: (r: any, j?: any) => Promise.resolve(mockRows).then(r, j),
        }),
        then: (r: any, j?: any) => Promise.resolve(mockRows).then(r, j),
      };
    },
    returning: (_cols?: any) => Promise.resolve(mockRows),
    limit: (_n: any) => chain,
    offset: (_o: any) => chain,
  };
  return chain;
}

mock.module("../db/connection", () => ({
  getDb: () => createChainableDb(),
}));

// ── Import subject after mocks ───────────────────────────────────────

import {
  persistError,
  listErrors,
  cleanupOldErrors,
  countErrors,
} from "../db/queries/error-logs";

// ── Tests ─────────────────────────────────────────────────────────────

afterAll(() => { mock.restore(); restoreModuleMocks(); });

describe("error-logs queries", () => {
  beforeEach(() => resetMockState());

  describe("persistError", () => {
    test("inserts error log entry", async () => {
      mockRows = [{ id: "err-1" }];

      await persistError({
        level: "error",
        message: "Something went wrong",
        stack: "Error: ...",
        metadata: { route: "/api/test" },
      });

      expect(lastInsertValues).toBeDefined();
      expect(lastInsertValues.level).toBe("error");
      expect(lastInsertValues.message).toBe("Something went wrong");
      expect(lastInsertValues.stack).toBe("Error: ...");
      expect(lastInsertValues.metadata).toEqual({ route: "/api/test" });
    });

    test("silently ignores DB errors (fire-and-forget)", async () => {
      shouldThrow = true;

      // Should not throw
      await expect(
        persistError({ level: "error", message: "test" })
      ).resolves.toBeUndefined();
    });
  });

  describe("listErrors", () => {
    test("returns errors with default pagination", async () => {
      const errors = [
        { id: "e1", level: "error", message: "err1", createdAt: new Date() },
        { id: "e2", level: "warn", message: "err2", createdAt: new Date() },
      ];
      mockRows = errors;

      const result = await listErrors();
      expect(result).toEqual(errors as typeof result);
    });

    test("supports custom limit and offset", async () => {
      mockRows = [];
      const result = await listErrors({ limit: 10, offset: 20 });
      expect(result).toEqual([]);
    });
  });

  describe("cleanupOldErrors", () => {
    test("deletes old entries and returns count", async () => {
      mockRows = [{ id: "e1" }, { id: "e2" }, { id: "e3" }];
      const count = await cleanupOldErrors();
      expect(count).toBe(3);
    });

    test("accepts custom retention days", async () => {
      mockRows = [];
      const count = await cleanupOldErrors(7);
      expect(count).toBe(0);
    });
  });

  describe("countErrors", () => {
    test("returns count from DB", async () => {
      mockRows = [{ count: 5 }];
      const result = await countErrors();
      expect(result).toBe(5);
    });

    test("returns 0 when no errors", async () => {
      mockRows = [{ count: 0 }];
      const result = await countErrors();
      expect(result).toBe(0);
    });
  });
});
