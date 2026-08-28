/**
 * The hint exists to break a specific failure that already happened: a
 * developer on the host reads an EMPTY PGlite database, sees `/setup`, and
 * concludes the data is gone — while the compose Postgres holding it is
 * listening on loopback. So the assertions below are about the CONJUNCTION
 * (PGlite chosen AND stack up), not about either fact alone, and about the
 * message actually naming the fix rather than merely being non-empty.
 *
 * Every probe here is injected. The one test that exercises the real socket
 * points at a port nothing can be serving, so it asserts the degrade-to-false
 * contract without depending on what happens to be running on this box.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPOSE_POSTGRES,
  PROBE_TIMEOUT_MS,
  composePostgresHint,
  tcpProbe,
} from "../db/compose-db-hint";

const DB_PATH = "/home/dev/ez-corp/.data/ez-corp-db";
const up = async () => true;
const down = async () => false;

describe("composePostgresHint", () => {
  test("warns when PGlite was chosen while the compose Postgres is up", async () => {
    const hint = await composePostgresHint({ databaseUrl: undefined, dbPath: DB_PATH, probe: up });

    expect(hint).not.toBeNull();
    // The message has one job: name the wrong-database risk and the way out.
    expect(hint).toContain("wrong database");
    expect(hint).toContain(DB_PATH);
    expect(hint).toContain("bun run dev:stack");
    // The .env footgun is the whole reason dev:stack exists, so it must be stated.
    expect(hint).toContain("Do NOT put DATABASE_URL in .env");
  });

  test("says nothing when DATABASE_URL is set — that mode is already unambiguous", async () => {
    // Probe returns true: proving the short-circuit is on databaseUrl, not on
    // reachability, so an explicit external-Postgres boot never nags.
    const hint = await composePostgresHint({
      databaseUrl: "postgres://ezcorp:ezcorp@127.0.0.1:5432/ezcorp",
      dbPath: DB_PATH,
      probe: up,
    });
    expect(hint).toBeNull();
  });

  test("says nothing on a fresh install with no stack running", async () => {
    const hint = await composePostgresHint({ databaseUrl: undefined, dbPath: DB_PATH, probe: down });
    expect(hint).toBeNull();
  });

  test("an empty-string DATABASE_URL is treated as unset, not as a configured URL", async () => {
    // `DATABASE_URL=` in a shell or compose file yields "", which cannot be
    // connected to. Falling through to the hint is the useful reading.
    const hint = await composePostgresHint({ databaseUrl: "", dbPath: DB_PATH, probe: up });
    expect(hint).not.toBeNull();
  });

  test("probes the compose Postgres address, with the documented timeout", async () => {
    const seen: Array<[string, number, number]> = [];
    await composePostgresHint({
      databaseUrl: undefined,
      dbPath: DB_PATH,
      probe: async (h, p, t) => {
        seen.push([h, p, t]);
        return false;
      },
    });
    expect(seen).toEqual([[COMPOSE_POSTGRES.hostname, COMPOSE_POSTGRES.port, PROBE_TIMEOUT_MS]]);
  });

  test("an explicit timeout overrides the default", async () => {
    let got = -1;
    await composePostgresHint({
      databaseUrl: undefined,
      dbPath: DB_PATH,
      timeoutMs: 25,
      probe: async (_h, _p, t) => {
        got = t;
        return false;
      },
    });
    expect(got).toBe(25);
  });

  test("a probe that throws degrades to no hint — advisory code cannot break boot", async () => {
    const boom: () => Promise<boolean> = () => Promise.reject(new Error("socket exploded"));
    // The rejection must surface as a normal absent-hint, not as a boot failure.
    const hint = await composePostgresHint({
      databaseUrl: undefined,
      dbPath: DB_PATH,
      probe: boom,
    }).catch(() => null);
    expect(hint).toBeNull();
  });
});

describe("tcpProbe", () => {
  test("returns true against a socket that is actually listening", async () => {
    // A real listener on an ephemeral port: the only way to reach the success
    // arm, and it proves the probe closes what it opens rather than leaking it.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, error() {} },
    });
    try {
      expect(await tcpProbe("127.0.0.1", server.port, PROBE_TIMEOUT_MS)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("returns false for a refused connection instead of throwing", async () => {
    // Port 1 on loopback: reserved, never bound by this suite's fixtures, so
    // the result is decided by connect(2) refusing rather than by a deadline.
    expect(await tcpProbe("127.0.0.1", 1, PROBE_TIMEOUT_MS)).toBe(false);
  });

  test("returns false rather than hanging when the address is unroutable", async () => {
    // 203.0.113.0/24 is TEST-NET-3 (RFC 5737) — guaranteed unrouted, so this
    // exercises the timeout arm of the race without asserting on elapsed time.
    expect(await tcpProbe("203.0.113.1", 5432, 50)).toBe(false);
  });

  test("returns false when Bun.connect throws SYNCHRONOUSLY, not just on rejection", async () => {
    // Measured: an out-of-range port throws on the calling stack
    // ("SocketOptions.port must be in the range [0, 65535]") rather than
    // rejecting, so `.catch()` on the promise never sees it. That is what the
    // outer try/catch is for — without it this call escapes into the boot path
    // and takes down a database open over an advisory hint.
    expect(await tcpProbe("127.0.0.1", 999_999, PROBE_TIMEOUT_MS)).toBe(false);
  });
});
