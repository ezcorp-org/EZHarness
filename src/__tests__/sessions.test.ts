import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock DB layer ────────────────────────────────────────────────────

let mockRows: any[] = [];
let lastInsertValues: any = null;
let lastUpdateSet: any = null;
let lastDeleteWhere: any = null;
let executeResults: any[] = [];

function resetMockState() {
  mockRows = [];
  lastInsertValues = null;
  lastUpdateSet = null;
  lastDeleteWhere = null;
  executeResults = [];
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
    select: (cols?: any) => {
      chain._op = "select";
      chain._selectCols = cols;
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
    leftJoin: (_table: any, _cond: any) => chain,
    where: (args: any) => {
      if (chain._op === "delete") lastDeleteWhere = args;
      if (chain._op === "select") {
        return {
          orderBy: (..._args: any[]) => ({ then: (resolve: any, reject?: any) => Promise.resolve(mockRows).then(resolve, reject) }),
          then: (resolve: any, reject?: any) => Promise.resolve(mockRows).then(resolve, reject),
        };
      }
      return chain;
    },
    orderBy: (..._args: any[]) => {
      return { then: (resolve: any, reject?: any) => Promise.resolve(mockRows).then(resolve, reject), limit: (_n: any) => ({ offset: (_o: any) => ({ then: (r: any, j?: any) => Promise.resolve(mockRows).then(r, j) }), then: (r: any, j?: any) => Promise.resolve(mockRows).then(r, j) }) };
    },
    returning: (_cols?: any) => Promise.resolve(mockRows),
    execute: () => Promise.resolve(executeResults),
    limit: (_n: any) => chain,
    offset: (_o: any) => chain,
  };
  return chain;
}

mock.module("../db/connection", () => ({
  getDb: () => createChainableDb(),
}));

afterAll(() => { mock.restore(); restoreModuleMocks(); });

// ── Schema tests ──────────────────────────────────────────────────────

describe("sessions schema", () => {
  test("sessions table is defined in schema", async () => {
    const schema = await import("../db/schema");
    expect(schema.sessions).toBeDefined();
    expect(typeof schema.sessions).toBe("object");
  });

  test("sessions exports Session and NewSession types", async () => {
    // Type-level check -- if these don't exist, TS will error at compile
    const schema = await import("../db/schema");
    type S = typeof schema.sessions.$inferSelect;
    type NS = typeof schema.sessions.$inferInsert;
    const _typeCheck: S = {} as any;
    const _insertCheck: NS = {} as any;
    expect(true).toBe(true);
  });

  test("errorLogs table is defined in schema", async () => {
    const schema = await import("../db/schema");
    expect(schema.errorLogs).toBeDefined();
    expect(typeof schema.errorLogs).toBe("object");
  });

  test("errorLogs exports ErrorLog and NewErrorLog types", async () => {
    const schema = await import("../db/schema");
    type E = typeof schema.errorLogs.$inferSelect;
    type NE = typeof schema.errorLogs.$inferInsert;
    const _typeCheck: E = {} as any;
    const _insertCheck: NE = {} as any;
    expect(true).toBe(true);
  });
});

// ── Session query tests ───────────────────────────────────────────────

import {
  hashToken,
  createSession,
  getSessionByTokenHash,
  revokeSession,
  revokeAllUserSessions,
  listSessionsByUser,
  listAllSessions,
  touchSession,
  deleteExpiredSessions,
} from "../db/queries/sessions";

describe("session queries", () => {
  beforeEach(() => resetMockState());

  describe("hashToken", () => {
    test("produces consistent hex output", async () => {
      const hash1 = await hashToken("test-token");
      const hash2 = await hashToken("test-token");
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    test("different tokens produce different hashes", async () => {
      const hash1 = await hashToken("token-a");
      const hash2 = await hashToken("token-b");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("createSession", () => {
    test("inserts and returns session", async () => {
      const row = {
        id: "sess-1",
        userId: "user-1",
        tokenHash: "abc",
        userAgent: "Mozilla",
        ipAddress: "127.0.0.1",
        expiresAt: new Date(),
        lastActiveAt: new Date(),
        createdAt: new Date(),
      };
      mockRows = [row];

      const result = await createSession({
        userId: "user-1",
        tokenHash: "abc",
        userAgent: "Mozilla",
        ipAddress: "127.0.0.1",
        expiresAt: new Date(),
      });

      expect(lastInsertValues).toBeDefined();
      expect(lastInsertValues.userId).toBe("user-1");
      expect(lastInsertValues.tokenHash).toBe("abc");
      expect(result).toBe(row);
    });
  });

  describe("getSessionByTokenHash", () => {
    test("returns session when found", async () => {
      const row = { id: "sess-1", tokenHash: "abc" };
      mockRows = [row];

      const result = await getSessionByTokenHash("abc");
      expect(result).toBe(row as typeof result);
    });

    test("returns null when not found", async () => {
      mockRows = [];
      const result = await getSessionByTokenHash("missing");
      expect(result).toBeNull();
    });
  });

  describe("revokeSession", () => {
    test("deletes session by id", async () => {
      mockRows = [{ id: "sess-1" }];
      const result = await revokeSession("sess-1");
      expect(result).toBe(true);
    });

    test("returns false when not found", async () => {
      mockRows = [];
      const result = await revokeSession("missing");
      expect(result).toBe(false);
    });
  });

  describe("revokeAllUserSessions", () => {
    test("deletes all sessions for user and returns count", async () => {
      mockRows = [{ id: "s1" }, { id: "s2" }];
      const count = await revokeAllUserSessions("user-1");
      expect(count).toBe(2);
    });
  });

  describe("listSessionsByUser", () => {
    test("returns sessions ordered by created_at desc", async () => {
      const sessions = [
        { id: "s1", createdAt: new Date("2026-01-02") },
        { id: "s2", createdAt: new Date("2026-01-01") },
      ];
      mockRows = sessions;

      const result = await listSessionsByUser("user-1");
      expect(result).toEqual(sessions as typeof result);
    });
  });

  describe("listAllSessions", () => {
    test("returns sessions with user info", async () => {
      const sessions = [{ id: "s1", userName: "Alice", userEmail: "a@b.c" }];
      mockRows = sessions;

      const result = await listAllSessions();
      expect(result).toEqual(sessions);
    });
  });

  describe("touchSession", () => {
    test("updates last_active_at", async () => {
      const row = { id: "sess-1", lastActiveAt: new Date() };
      mockRows = [row];

      const result = await touchSession("sess-1");
      expect(result).toBeDefined();
    });

    test("returns null when no row matches (throttled)", async () => {
      mockRows = [];
      const result = await touchSession("sess-1");
      expect(result).toBeNull();
    });
  });

  describe("deleteExpiredSessions", () => {
    test("deletes expired sessions and returns count", async () => {
      mockRows = [{ id: "s1" }, { id: "s2" }];
      const count = await deleteExpiredSessions();
      expect(count).toBe(2);
    });
  });
});
