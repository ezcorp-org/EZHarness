import { expect, test } from "vitest";

/**
 * W09g: the shared database module loads under Vite.
 *
 * `src/db/connection.ts` reaches every factory route and route kit through the
 * server modules the web tests import. A bare `import("bun")` in it made Vite's
 * import analysis fail ("Failed to resolve import \"bun\"") and took four route
 * suites down to zero tests on integ c3da32784. The Bun SQL class now comes from
 * the runtime (`Bun.SQL`), which needs no import, and outside Bun it is refused
 * by name only if an external pool is actually opened.
 */
test("src/db/connection.ts loads under Vite, and the Bun SQL class is refused by name outside Bun", async () => {
	const connection = await import("../../../../src/db/connection");
	expect(typeof connection.initDb).toBe("function");
	expect(typeof connection.getDb).toBe("function");
	// Vitest runs under Node, not Bun.
	expect((globalThis as { Bun?: unknown }).Bun).toBeUndefined();
	expect(() => connection.bunSqlClass()).toThrow("the external PostgreSQL pool needs the Bun runtime (Bun.SQL is unavailable)");
	expect(() => connection.bunSqlClass({})).toThrow("Bun.SQL is unavailable");
	class Fake {}
	expect(connection.bunSqlClass({ SQL: Fake })).toBe(Fake);
});
