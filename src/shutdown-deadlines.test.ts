import { describe, expect, test } from "bun:test";
import {
  DB_OPEN_CONNECTIONS_QUERY_DEADLINE_MS,
  DB_POOL_CLOSE_DEADLINE_MS,
  FACTORY_WORKER_STOP_DEADLINE_MS,
  TEARDOWN_TIMEOUT_MS,
  withinDeadline,
} from "./shutdown-deadlines";

describe("the shutdown deadlines", () => {
  test("the factory roles' stop ends inside one teardown deadline, so its per-role line lands first", () => {
    expect(FACTORY_WORKER_STOP_DEADLINE_MS).toBeLessThan(TEARDOWN_TIMEOUT_MS);
  });

  test("the database close plus its open-connection listing end inside one teardown deadline", () => {
    expect(DB_POOL_CLOSE_DEADLINE_MS + DB_OPEN_CONNECTIONS_QUERY_DEADLINE_MS).toBeLessThan(TEARDOWN_TIMEOUT_MS);
  });
});

describe("withinDeadline", () => {
  test("resolves with the value of work that settles first", async () => {
    expect(await withinDeadline(Promise.resolve(7), 60_000)).toEqual({ settled: true, value: 7 });
  });

  test("resolves unsettled when the deadline passes first, leaving the work running", async () => {
    expect(await withinDeadline(new Promise<never>(() => {}), 1)).toEqual({ settled: false });
  });

  test("propagates a rejection of the work", async () => {
    await expect(withinDeadline(Promise.reject(new Error("refused")), 60_000)).rejects.toThrow("refused");
  });
});
