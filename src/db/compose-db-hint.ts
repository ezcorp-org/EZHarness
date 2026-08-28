/**
 * Catch the "wrong database, silently" trap.
 *
 * The dev stack's real database is the Postgres in `docker-compose.yml`, and
 * `DATABASE_URL` is set ONLY on that file's `app` service (line 43). Run the
 * server on the HOST instead — `bun run dev` — and no `DATABASE_URL` reaches
 * it, so `connection.ts` falls back to embedded PGlite at `EZCORP_DB_PATH`.
 * That fallback is legitimate (a fresh install has no Postgres), which is why
 * it cannot be an error. It is also indistinguishable, from the logs, from
 * the case that matters: a developer whose real data is in the compose
 * Postgres, looking at an empty PGlite database and concluding the data is
 * gone.
 *
 * That is not hypothetical. It cost one session hours: 179 PGlite datadirs
 * were searched, every one holding nothing but e2e fixtures, and the
 * conclusion drawn was "there is no data to recover" — while 978
 * conversations and 8,644 messages sat in the compose Postgres, reachable on
 * localhost the whole time. The single `log.info("Database mode: embedded
 * PGlite")` was present and true, and told nobody anything, because it reads
 * identically whether or not the other database exists.
 *
 * So the signal here is not "which mode am I in" — the app already logs that.
 * It is the CONJUNCTION: PGlite was chosen AND this repo's compose Postgres
 * is listening. On a dev box that pair is almost always a mistake, and it is
 * cheap to detect (one TCP connect to loopback, refused instantly when the
 * stack is down).
 *
 * ## Why not just put DATABASE_URL in `.env`
 *
 * Because Bun auto-loads `.env` into EVERY process, and
 * `src/__tests__/preload.ts` mints its throwaway datadir only when NEITHER
 * `EZCORP_DB_PATH` nor `DATABASE_URL` is set:
 *
 *     if (!process.env.EZCORP_DB_PATH && !process.env.DATABASE_URL) { ... }
 *
 * A `DATABASE_URL` in `.env` therefore points the whole backend pool at that
 * database, where `migrate()` runs and suites write and truncate. The obvious
 * fix is a data-loss bug strictly worse than the confusion it cures. Use
 * `bun run dev:stack`, which scopes the variable to the dev server.
 */

/** Where `docker-compose.yml` publishes the dev stack's Postgres. */
export const COMPOSE_POSTGRES = { hostname: "127.0.0.1", port: 5432 } as const;

/** Loopback connect budget. Refusal is immediate; this only bounds a firewall. */
export const PROBE_TIMEOUT_MS = 300;

/** Injectable so the unit tests never touch a real socket. */
export type ProbeFn = (hostname: string, port: number, timeoutMs: number) => Promise<boolean>;

/**
 * Is something accepting TCP on `hostname:port`?
 *
 * Never throws and never outlives `timeoutMs`: a probe that fails must degrade
 * to "no hint", because this is advisory and runs on the boot path.
 */
export const tcpProbe: ProbeFn = async (hostname, port, timeoutMs) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connecting = Bun.connect({
      hostname,
      port,
      socket: { data() {}, error() {}, open() {} },
    })
      .then((socket) => {
        socket.end();
        return true;
      })
      .catch(() => false);
    const timing = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([connecting, timing]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export interface HintOptions {
  /** `process.env.DATABASE_URL` as `connection.ts` read it. */
  databaseUrl: string | undefined;
  /** The PGlite datadir that WAS opened, for the message. */
  dbPath: string;
  probe?: ProbeFn;
  timeoutMs?: number;
}

/**
 * Returns the warning text when embedded PGlite was selected while this repo's
 * compose Postgres is up, or `null` when there is nothing to say.
 *
 * `null` on every other path, deliberately: external-Postgres mode is already
 * unambiguous, and a dev box with no stack running is the ordinary fresh-install
 * case that must stay quiet.
 */
export async function composePostgresHint(options: HintOptions): Promise<string | null> {
  // External Postgres was chosen explicitly — nothing ambiguous to report.
  if (options.databaseUrl) return null;

  const probe = options.probe ?? tcpProbe;
  const reachable = await probe(
    COMPOSE_POSTGRES.hostname,
    COMPOSE_POSTGRES.port,
    options.timeoutMs ?? PROBE_TIMEOUT_MS,
  );
  if (!reachable) return null;

  return [
    "Using the EMBEDDED PGlite database, but this repo's compose Postgres is running.",
    `You are probably looking at the wrong database: PGlite at ${options.dbPath} is a`,
    `separate, usually EMPTY store, while the dev stack keeps its data in Postgres on`,
    `${COMPOSE_POSTGRES.hostname}:${COMPOSE_POSTGRES.port}. A blank app and a redirect to /setup are the symptom.`,
    "",
    "  Use the stack's database:  bun run dev:stack",
    "  Or set it for this run:    DATABASE_URL=postgres://ezcorp:ezcorp@127.0.0.1:5432/ezcorp bun run dev",
    "",
    "Do NOT put DATABASE_URL in .env — Bun loads .env into every process, and the test",
    "pool would then run migrate() and write against that database (see preload.ts).",
  ].join("\n");
}
