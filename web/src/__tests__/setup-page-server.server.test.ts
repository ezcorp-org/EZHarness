/**
 * Server-side load tests for /setup/+page.server.ts.
 *
 * First-run setup page-load gate: when no users exist, the load
 * resolves to `{}` and the setup form renders. As soon as any user
 * exists, the load throws a SvelteKit 302 redirect to `/login` so
 * the bootstrap flow can never re-run on a populated instance.
 * DB errors propagate (no swallowing at this layer).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(),
}));

import { getUserCount } from "$server/db/queries/users";
import { load } from "../routes/(auth)/setup/+page.server";

describe("/setup/+page.server load", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset();
  });

  test("returns {} when no users exist (count = 0)", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    expect(await load({} as any)).toEqual({});
  });

  test("throws 302 redirect to /login when a user exists (count = 1)", async () => {
    vi.mocked(getUserCount).mockResolvedValue(1);
    let caught: unknown;
    try {
      await load({} as any);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status?: number }).status).toBe(302);
    expect((caught as { location?: string }).location).toBe("/login");
  });

  test("throws 302 redirect to /login for large user counts (count = 100)", async () => {
    vi.mocked(getUserCount).mockResolvedValue(100);
    let caught: unknown;
    try {
      await load({} as any);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status?: number }).status).toBe(302);
    expect((caught as { location?: string }).location).toBe("/login");
  });

  test("propagates rejection when getUserCount fails (no swallowing)", async () => {
    vi.mocked(getUserCount).mockRejectedValue(new Error("db down"));
    await expect(load({} as any)).rejects.toThrow();
  });
});
