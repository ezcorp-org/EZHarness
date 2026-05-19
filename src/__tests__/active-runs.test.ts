import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock DB layer ────────────────────────────────────────────────────

let mockRows: any[] = [];
let lastInsertValues: any = null;
let lastUpdateSet: any = null;
let _lastWhereArgs: any = null;
let _lastDeleteWhere: any = null;

function resetMockState() {
  mockRows = [];
  lastInsertValues = null;
  lastUpdateSet = null;
  _lastWhereArgs = null;
  _lastDeleteWhere = null;
}

function createChainableDb() {
  const chain: any = {
    _op: null,
    insert: (_table: any) => {
      chain._op = "insert";
      return chain;
    },
    values: (vals: any) => {
      lastInsertValues = vals;
      return chain;
    },
    select: () => {
      chain._op = "select";
      return chain;
    },
    from: (_table: any) => chain,
    update: (_table: any) => {
      chain._op = "update";
      return chain;
    },
    set: (vals: any) => {
      lastUpdateSet = vals;
      return chain;
    },
    delete: (_table: any) => {
      chain._op = "delete";
      return chain;
    },
    where: (args: any) => {
      if (chain._op === "delete") _lastDeleteWhere = args;
      else _lastWhereArgs = args;
      // For select, where is terminal (returns thenable)
      if (chain._op === "select") {
        return { then: (resolve: any, reject?: any) => Promise.resolve(mockRows).then(resolve, reject) };
      }
      return chain;
    },
    returning: (_cols?: any) => Promise.resolve(mockRows),
  };
  return chain;
}

mock.module("../db/connection", () => ({
  getDb: () => createChainableDb(),
}));

// ── Import subject after mocks ───────────────────────────────────────

import {
  createActiveRun,
  getActiveRun,
  updateHeartbeat,
  updatePartialResponse,
  markInterrupted,
  cleanupOrphanedRuns,
  deleteActiveRun,
} from "../db/queries/active-runs";

// ── Tests ────────────────────────────────────────────────────────────

describe("active-runs queries", () => {
  beforeEach(() => resetMockState());

  describe("createActiveRun", () => {
    test("inserts row and returns it", async () => {
      const row = { id: "run-1", conversationId: "conv-1", status: "running", startedAt: new Date(), lastHeartbeat: new Date(), partialResponse: null };
      mockRows = [row];

      const result = await createActiveRun("run-1", "conv-1");

      expect(lastInsertValues).toEqual({ id: "run-1", conversationId: "conv-1" });
      expect(result).toBe(row);
      expect(result.status).toBe("running");
    });
  });

  describe("getActiveRun", () => {
    test("returns matching running row", async () => {
      const row = { id: "run-1", conversationId: "conv-1", status: "running" };
      mockRows = [row];

      const result = await getActiveRun("conv-1");
      expect(result).toBe(row);
    });

    test("returns null when no rows match", async () => {
      mockRows = [];

      const result = await getActiveRun("conv-missing");
      expect(result).toBeNull();
    });
  });

  describe("updateHeartbeat", () => {
    test("calls update with NOW() and returns row", async () => {
      const row = { id: "run-1", lastHeartbeat: new Date() };
      mockRows = [row];

      const result = await updateHeartbeat("run-1");

      expect(lastUpdateSet).toBeDefined();
      expect(lastUpdateSet.lastHeartbeat).toBeDefined(); // sql`NOW()` template
      expect(result).toBe(row);
    });

    test("returns null when run not found", async () => {
      mockRows = [];
      const result = await updateHeartbeat("missing");
      expect(result).toBeNull();
    });
  });

  describe("updatePartialResponse", () => {
    test("stores partial response text", async () => {
      const row = { id: "run-1", partialResponse: "Hello so far" };
      mockRows = [row];

      const result = await updatePartialResponse("run-1", "Hello so far");

      expect(lastUpdateSet).toEqual({ partialResponse: "Hello so far" });
      expect(result).toBe(row);
    });

    test("returns null when run not found", async () => {
      mockRows = [];
      const result = await updatePartialResponse("missing", "text");
      expect(result).toBeNull();
    });
  });

  describe("markInterrupted", () => {
    test("sets status to interrupted", async () => {
      const row = { id: "run-1", status: "interrupted" };
      mockRows = [row];

      const result = await markInterrupted("run-1");

      expect(lastUpdateSet).toEqual({ status: "interrupted" });
      expect(result!.status).toBe("interrupted");
    });

    test("returns null when run not found", async () => {
      mockRows = [];
      const result = await markInterrupted("missing");
      expect(result).toBeNull();
    });
  });

  describe("cleanupOrphanedRuns", () => {
    test("marks stale runs as interrupted and returns count", async () => {
      mockRows = [{ id: "run-1" }, { id: "run-2" }];

      const count = await cleanupOrphanedRuns(5);

      expect(lastUpdateSet).toEqual({ status: "interrupted" });
      expect(count).toBe(2);
    });

    test("returns 0 when no stale runs", async () => {
      mockRows = [];
      const count = await cleanupOrphanedRuns(5);
      expect(count).toBe(0);
    });
  });

  describe("deleteActiveRun", () => {
    test("removes row and returns true", async () => {
      mockRows = [{ id: "run-1" }];

      const result = await deleteActiveRun("run-1");
      expect(result).toBe(true);
    });

    test("returns false when row not found", async () => {
      mockRows = [];
      const result = await deleteActiveRun("missing");
      expect(result).toBe(false);
    });
  });
});
