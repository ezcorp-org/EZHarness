/**
 * Phase 68 Plan 01 — Wave-0 RED contract for the embedding backfill CLI
 * (OPS-01 gaps-only + idempotent enqueue, OPS-02 throttle/env parse).
 *
 * THESE TESTS ARE INTENTIONALLY RED until Plans 02 + 04 land:
 *   - `parseArgs` / `runBackfill` are imported from `../../scripts/backfill-embeddings`,
 *     a module Plan 04 CREATES (mirroring scripts/sweep-perm-expiry.ts).
 *   - `enqueueEmbedJobIfAbsent`, `getBackfillBatchSize`, `getBackfillSleepMs`
 *     are imported from `../db/queries/message-embed-outbox`, which Plan 02 EXTENDS.
 * The top-level `await import(...)` therefore REJECTS with a module/export
 * resolution error — that is the Nyquist contract this scaffold pins. Plans
 * 02/04 turn it GREEN without editing the assertions.
 *
 * Contracts pinned (see 68-01-PLAN.md <interfaces>):
 *   OPS-01  gaps-only select  — enqueue ONLY eligible messages that have neither
 *           a message_chunks row NOR an existing outbox row; mirror the
 *           message-search.ts eligibility/test predicates (NOT re-derived):
 *             role IN ('user','assistant')                  (message-search.ts:195)
 *             (c.test IS NULL OR c.test = false)             (message-search.ts:139/194)
 *             content.trim().length > 0                      (message-chunker.isEmbedEligible)
 *   OPS-01  idempotency       — DO NOTHING (NOT DO UPDATE): a re-run enqueues 0
 *           and never resets a previously-failed row (contrast enqueueEmbedJob).
 *   OPS-01  dry-run           — writes nothing, return.enqueued reports the count
 *           it WOULD enqueue.
 *   OPS-02  env parse         — EZCORP_BACKFILL_BATCH_SIZE / _SLEEP_MS mirror the
 *           embed-worker idiom (undefined/empty→default, non-finite/≤0→default,
 *           floor + clamp), flags override env override default.
 *
 * Harness: the shared PGlite harness (helpers/test-pglite.ts), exactly like
 * message-embed-outbox-real.test.ts. We seed via RAW inserts (NOT createMessage)
 * because createMessage auto-enqueues eligible messages (conversations.ts:414),
 * which would pre-populate the outbox and defeat the gaps-only premise.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { useTempProjectRoot } from "./helpers/temp-project-root";
import { eq, sql } from "drizzle-orm";

mockDbConnection();

const { runBackfill, parseArgs, main, isWorkerDown, isProcessAlive } = await import(
  "../../scripts/backfill-embeddings"
);
const { enqueueEmbedJobIfAbsent, getBackfillBatchSize, getBackfillSleepMs } = await import(
  "../db/queries/message-embed-outbox"
);
const { createProject } = await import("../db/queries/projects");
const { conversations, messages, messageChunks, messageEmbedOutbox } = await import("../db/schema");
const { EMBEDDING_MODEL_ID } = await import("../memory/embeddings");

// ── Raw seeders (bypass createMessage's auto-enqueue) ──────────────────────

async function seedConversation(opts: { test?: boolean | null } = {}) {
  const db = getTestDb();
  const project = await createProject({ name: "p", path: `/tmp/backfill-${crypto.randomUUID()}` });
  const [conv] = await db
    .insert(conversations)
    .values({ projectId: project.id, title: "c", test: opts.test ?? false })
    .returning();
  return conv!;
}

async function seedMessage(conversationId: string, role: string, content: string, createdAt?: Date) {
  const db = getTestDb();
  const [msg] = await db
    .insert(messages)
    .values({ conversationId, role, content, ...(createdAt ? { createdAt } : {}) })
    .returning();
  return msg!;
}

async function seedChunk(messageId: string, conversationId: string) {
  await getTestDb().insert(messageChunks).values({
    messageId,
    conversationId,
    content: "already-embedded chunk",
    chunkIndex: 0,
    embeddingModelId: EMBEDDING_MODEL_ID,
  });
}

async function seedStaleChunk(messageId: string, conversationId: string) {
  await getTestDb().insert(messageChunks).values({
    messageId,
    conversationId,
    content: "stale-model chunk",
    chunkIndex: 0,
    embeddingModelId: `${EMBEDDING_MODEL_ID}-OLD`, // differs from current model
  });
}

async function outboxRows() {
  return getTestDb().select().from(messageEmbedOutbox);
}

async function outboxFor(messageId: string) {
  return getTestDb().select().from(messageEmbedOutbox).where(eq(messageEmbedOutbox.messageId, messageId));
}

const FULL = { dryRun: false, refreshStale: false, projectId: null, batchSize: 50, sleepMs: 0 } as const;

describe("backfill-embeddings (OPS-01/OPS-02) — RED until Plans 02+04", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  describe("OPS-01 gaps-only select", () => {
    test("enqueues exactly the true gaps — skips chunked, already-queued, system, and test-conversation messages", async () => {
      const conv = await seedConversation();
      const testConv = await seedConversation({ test: true });

      // (a) eligible user msg, no chunks / no outbox → IS a gap (enqueue)
      const gap = await seedMessage(conv.id, "user", "find me");
      // (b) eligible assistant msg that ALREADY has a chunk → NOT a gap
      const chunked = await seedMessage(conv.id, "assistant", "already embedded");
      await seedChunk(chunked.id, conv.id);
      // (c) eligible user msg that already has an outbox row → NOT a gap
      const queued = await seedMessage(conv.id, "user", "already queued");
      await enqueueEmbedJobIfAbsent(getTestDb(), queued.id, conv.id);
      // (d) system-role msg → ineligible → NOT a gap
      await seedMessage(conv.id, "system", "system prompt");
      // (e) msg in a test=true conversation → excluded → NOT a gap
      await seedMessage(testConv.id, "user", "test convo message");
      // (f) whitespace-only eligible msg → ineligible (trim().length===0) → NOT a gap
      await seedMessage(conv.id, "user", "   ");

      const before = (await outboxRows()).length; // 1 (the pre-queued row)
      const result = await runBackfill(getTestDb(), { ...FULL });

      // Exactly one true gap was enqueued.
      expect(result.enqueued).toBe(1);
      expect((await outboxRows()).length).toBe(before + 1);
      expect((await outboxFor(gap.id)).length).toBe(1);
      // eligibleScanned counts true gaps the SUT considered enqueuing.
      expect(result.eligibleScanned).toBeGreaterThanOrEqual(1);
    });

    test("DO NOTHING leaves a pre-existing queued row's status/attempts untouched", async () => {
      const conv = await seedConversation();
      const queued = await seedMessage(conv.id, "user", "queued already");
      await enqueueEmbedJobIfAbsent(getTestDb(), queued.id, conv.id);
      // Mutate it to a terminal failed state.
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 3 })
        .where(eq(messageEmbedOutbox.messageId, queued.id));

      await runBackfill(getTestDb(), { ...FULL });

      const row = (await outboxFor(queued.id))[0]!;
      expect(row.status).toBe("failed"); // DO NOTHING — never reset to pending
      expect(row.attempts).toBe(3);
    });
  });

  describe("OPS-01 idempotency", () => {
    test("a second run enqueues 0 and total outbox rows are unchanged; a failed row survives a third run", async () => {
      const conv = await seedConversation();
      await seedMessage(conv.id, "user", "gap one");
      await seedMessage(conv.id, "assistant", "gap two");

      const first = await runBackfill(getTestDb(), { ...FULL });
      expect(first.enqueued).toBe(2);
      const afterFirst = (await outboxRows()).length;

      const second = await runBackfill(getTestDb(), { ...FULL });
      expect(second.enqueued).toBe(0);
      expect((await outboxRows()).length).toBe(afterFirst);

      // Drive one queued row to failed/attempts=3 between runs.
      const all = await outboxRows();
      const target = all[0]!;
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 3 })
        .where(eq(messageEmbedOutbox.messageId, target.messageId));

      const third = await runBackfill(getTestDb(), { ...FULL });
      expect(third.enqueued).toBe(0);
      const survivor = (await outboxFor(target.messageId))[0]!;
      expect(survivor.status).toBe("failed"); // DO NOTHING must not reset it
      expect(survivor.attempts).toBe(3);
    });
  });

  describe("OPS-01 enqueueEmbedJobIfAbsent (unit)", () => {
    test("calling twice for the same message inserts exactly one row", async () => {
      const conv = await seedConversation();
      const msg = await seedMessage(conv.id, "user", "x");

      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);
      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);

      const rows = await outboxFor(msg.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
    });

    test("a pre-existing 'failed' row is left intact (DO NOTHING, not DO UPDATE)", async () => {
      const conv = await seedConversation();
      const msg = await seedMessage(conv.id, "user", "x");
      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 5 })
        .where(eq(messageEmbedOutbox.messageId, msg.id));

      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);

      const row = (await outboxFor(msg.id))[0]!;
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(5);
    });
  });

  describe("OPS-01 dry-run", () => {
    test("writes nothing but reports the count it would enqueue", async () => {
      const conv = await seedConversation();
      await seedMessage(conv.id, "user", "gap one");
      await seedMessage(conv.id, "assistant", "gap two");

      const before = (await outboxRows()).length;
      const result = await runBackfill(getTestDb(), { ...FULL, dryRun: true });

      expect(result.enqueued).toBe(2); // count it WOULD enqueue
      expect((await outboxRows()).length).toBe(before); // wrote nothing
    });
  });

  describe("OPS-02 env parse (mirror embed-worker idiom)", () => {
    let savedBatch: string | undefined;
    let savedSleep: string | undefined;
    beforeEach(() => {
      savedBatch = process.env.EZCORP_BACKFILL_BATCH_SIZE;
      savedSleep = process.env.EZCORP_BACKFILL_SLEEP_MS;
      delete process.env.EZCORP_BACKFILL_BATCH_SIZE;
      delete process.env.EZCORP_BACKFILL_SLEEP_MS;
    });
    afterAll(() => {
      if (savedBatch === undefined) delete process.env.EZCORP_BACKFILL_BATCH_SIZE;
      else process.env.EZCORP_BACKFILL_BATCH_SIZE = savedBatch;
      if (savedSleep === undefined) delete process.env.EZCORP_BACKFILL_SLEEP_MS;
      else process.env.EZCORP_BACKFILL_SLEEP_MS = savedSleep;
    });

    test("batch size: undefined/empty → default; non-finite/≤0 → default; floors + clamps", () => {
      const def = getBackfillBatchSize();
      expect(def).toBeGreaterThan(0);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "not-a-number";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "0";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "-7";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "12.9";
      expect(getBackfillBatchSize()).toBe(12); // Math.floor

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "250";
      expect(getBackfillBatchSize()).toBeGreaterThanOrEqual(1);
    });

    test("sleep ms: undefined/empty → default; non-finite/negative → default; floors", () => {
      const def = getBackfillSleepMs();
      expect(def).toBeGreaterThanOrEqual(0);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "";
      expect(getBackfillSleepMs()).toBe(def);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "garbage";
      expect(getBackfillSleepMs()).toBe(def);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "-5";
      expect(getBackfillSleepMs()).toBe(def);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "40.7";
      expect(getBackfillSleepMs()).toBe(40); // Math.floor
    });
  });

  describe("parseArgs", () => {
    test("parses every supported flag (long + short forms)", () => {
      const parsed = parseArgs([
        "--dry-run",
        "--verbose",
        "--status",
        "--refresh-stale",
        "--project",
        "proj-123",
        "--batch-size",
        "25",
        "--sleep-ms",
        "100",
      ]);
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) throw new Error("unreachable");
      expect(parsed.dryRun).toBe(true);
      expect(parsed.verbose).toBe(true);
      expect(parsed.status).toBe(true);
      expect(parsed.refreshStale).toBe(true);
      expect(parsed.projectId).toBe("proj-123");
      expect(parsed.batchSize).toBe(25);
      expect(parsed.sleepMs).toBe(100);
    });

    test("short flags -n / -v map to dry-run / verbose", () => {
      const parsed = parseArgs(["-n", "-v"]);
      if ("error" in parsed) throw new Error("unexpected error");
      expect(parsed.dryRun).toBe(true);
      expect(parsed.verbose).toBe(true);
    });

    test("empty argv yields all-defaults (no flags set)", () => {
      const parsed = parseArgs([]);
      if ("error" in parsed) throw new Error("unexpected error");
      expect(parsed.dryRun).toBe(false);
      expect(parsed.verbose).toBe(false);
      expect(parsed.status).toBe(false);
      expect(parsed.refreshStale).toBe(false);
      expect(parsed.projectId).toBe(null);
    });

    test("--help / -h → {error:'help'}", () => {
      expect(parseArgs(["--help"])).toEqual({ error: "help" });
      expect(parseArgs(["-h"])).toEqual({ error: "help" });
    });

    test("unknown flag → {error:'unknown flag: ...'}", () => {
      const parsed = parseArgs(["--bogus"]);
      expect("error" in parsed).toBe(true);
      if (!("error" in parsed)) throw new Error("unreachable");
      expect(parsed.error).toContain("unknown flag");
      expect(parsed.error).toContain("--bogus");
    });

    test("--batch-size requires a value; --sleep-ms rejects a negative integer", () => {
      // --batch-size with a missing trailing token.
      const a = parseArgs(["--batch-size"]);
      expect("error" in a).toBe(true);
      // --sleep-ms with a negative value (covers the sleep-ms validation branch).
      const b = parseArgs(["--sleep-ms", "-5"]);
      expect("error" in b).toBe(true);
      if (!("error" in b)) throw new Error("unreachable");
      expect(b.error).toContain("--sleep-ms requires a non-negative integer");
      // --project with a missing trailing token.
      const c = parseArgs(["--project"]);
      expect("error" in c).toBe(true);
      // --sleep-ms accepts 0 (no-pause sentinel).
      const ok = parseArgs(["--sleep-ms", "0"]);
      if ("error" in ok) throw new Error("unexpected error");
      expect(ok.sleepMs).toBe(0);
    });
  });

  describe("OPS-01 --refresh-stale (stale-model re-enqueue) + paced batches", () => {
    test("re-enqueues messages whose chunks use an OLD model via DO-UPDATE; a fresh-model chunk is left alone", async () => {
      const conv = await seedConversation();
      // (a) message chunked with the CURRENT model → NOT stale → not re-enqueued.
      const fresh = await seedMessage(conv.id, "assistant", "fresh-model chunked");
      await seedChunk(fresh.id, conv.id);
      // (b) message chunked with an OLD model → stale → re-enqueued by --refresh-stale.
      const stale = await seedMessage(conv.id, "assistant", "stale-model chunked");
      await seedStaleChunk(stale.id, conv.id);

      // WITHOUT --refresh-stale: both are chunked, so neither is a gap → 0 enqueued.
      const plain = await runBackfill(getTestDb(), { ...FULL });
      expect(plain.enqueued).toBe(0);
      expect((await outboxRows()).length).toBe(0);

      // WITH --refresh-stale: exactly the stale-model message is re-enqueued.
      const refreshed = await runBackfill(getTestDb(), { ...FULL, refreshStale: true });
      expect(refreshed.enqueued).toBe(1);
      expect((await outboxFor(stale.id)).length).toBe(1);
      expect((await outboxFor(fresh.id)).length).toBe(0);
    });

    test("--refresh-stale in dry-run reports the would-enqueue count but writes nothing", async () => {
      const conv = await seedConversation();
      const stale = await seedMessage(conv.id, "assistant", "stale chunk");
      await seedStaleChunk(stale.id, conv.id);

      const result = await runBackfill(getTestDb(), { ...FULL, refreshStale: true, dryRun: true });
      expect(result.enqueued).toBe(1);
      expect((await outboxRows()).length).toBe(0); // wrote nothing
    });

    test("paces between full pages: a sleepMs>0 run across two pages still enqueues every gap", async () => {
      const conv = await seedConversation();
      // Three gaps with batchSize=2 forces a multi-page loop that hits the
      // `sleepMs > 0` Bun.sleep branch between the first full page and the next.
      // DISTINCT, increasing created_at timestamps so the keyset cursor
      // (m.created_at > afterCreatedAt) advances deterministically — rows with
      // an identical defaultNow() stamp would be skipped on the second page.
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      await seedMessage(conv.id, "user", "gap a", new Date(t0.getTime() + 1000));
      await seedMessage(conv.id, "user", "gap b", new Date(t0.getTime() + 2000));
      await seedMessage(conv.id, "user", "gap c", new Date(t0.getTime() + 3000));

      const progressTicks: number[] = [];
      const result = await runBackfill(getTestDb(), {
        ...FULL,
        batchSize: 2,
        sleepMs: 1,
        onProgress: (p: { enqueued: number; eligible: number; backlog: number }) =>
          progressTicks.push(p.enqueued),
      });
      expect(result.enqueued).toBe(3);
      expect((await outboxRows()).length).toBe(3);
      // onProgress fired once per page (2 pages: 2 then 3).
      expect(progressTicks).toEqual([2, 3]);
    });
  });
});

// ── Plan 04 main()/exit-code + worker-liveness coverage ────────────────────
//
// These suites drive the CLI's orchestration layer IN-PROCESS (not via spawn)
// so the lines count toward this file's coverage. `mockDbConnection()` makes
// main()'s `initDb()` a no-op and `getDb()` return the shared PGlite harness,
// so main() runs end-to-end against the seeded test DB. We never call
// process.exit (the `import.meta.main` guard does that in production); we
// assert main()'s RETURNED exit code (0 / 1 / 2) plus its stdout/stderr.

/** Capture process.argv + std stream writes around one main() invocation. */
async function runMain(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const savedArgv = process.argv;
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  let stdout = "";
  let stderr = "";
  // process.argv[0]=runtime, [1]=script; main() reads slice(2).
  process.argv = ["bun", "scripts/backfill-embeddings.ts", ...args];
  (process.stdout.write as unknown) = (chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  (process.stderr.write as unknown) = (chunk: unknown) => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // printHelp() uses console.log, which does NOT route through the patched
  // process.stdout.write above — capture it explicitly onto the stdout buffer.
  console.log = (...parts: unknown[]) => {
    stdout += parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ") + "\n";
  };
  try {
    const code = await main();
    return { code, stdout, stderr };
  } finally {
    process.argv = savedArgv;
    (process.stdout.write as unknown) = origStdout;
    (process.stderr.write as unknown) = origStderr;
    console.log = origLog;
  }
}

describe("backfill-embeddings main() — exit codes + branches", () => {
  // The repo lockfile (.ezcorp/embed-worker.pid) points at a dead PID in CI,
  // so the worker-down WARNING fires by default. We force it deterministically
  // via the kill-switch env, saved/restored per test so we never leak it.
  let savedKill: string | undefined;
  beforeEach(async () => {
    await setupTestDb();
    savedKill = process.env.EZCORP_DISABLE_EMBED_WORKER;
    // Default: force worker DOWN so main()'s WARNING branch is exercised and
    // the result is independent of the host's real lockfile/PID liveness.
    process.env.EZCORP_DISABLE_EMBED_WORKER = "1";
  });
  afterEach(() => {
    if (savedKill === undefined) delete process.env.EZCORP_DISABLE_EMBED_WORKER;
    else process.env.EZCORP_DISABLE_EMBED_WORKER = savedKill;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("--help prints usage to stdout and returns 0 (no enqueue)", async () => {
    const conv = await seedConversation();
    await seedMessage(conv.id, "user", "a gap that must NOT be touched by --help");

    const { code, stdout } = await runMain(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--dry-run");
    // --help short-circuits before initDb/enqueue — nothing was queued.
    expect((await outboxRows()).length).toBe(0);
  });

  test("unknown flag writes an error + usage to stderr and returns 2", async () => {
    const { code, stdout, stderr } = await runMain(["--bogus"]);
    expect(code).toBe(2);
    // The error line goes to stderr; the usage text follows on stdout (console.log).
    expect(stderr).toContain("unknown flag: --bogus");
    expect(stdout).toContain("Usage:");
  });

  test("a bad numeric arg also returns the invocation-error code 2", async () => {
    const { code, stderr } = await runMain(["--batch-size", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--batch-size requires a positive integer");
  });

  test("--status prints the getEmbedProgress JSON to stdout and returns 0, enqueuing nothing", async () => {
    const conv = await seedConversation();
    // One eligible gap (counts toward coverage.eligibleMessages) + one chunked
    // (counts toward embeddedMessages).
    await seedMessage(conv.id, "user", "uncovered gap");
    const chunked = await seedMessage(conv.id, "assistant", "already embedded");
    await seedChunk(chunked.id, conv.id);

    const { code, stdout } = await runMain(["--status"]);
    expect(code).toBe(0);
    const progress = JSON.parse(stdout);
    expect(progress).toEqual({
      backlog: { pending: 0, inProgress: 0, failed: 0, total: 0 },
      coverage: { eligibleMessages: 2, embeddedMessages: 1 },
    });
    // --status must enqueue NOTHING.
    expect((await outboxRows()).length).toBe(0);
  });

  test("default apply enqueues the gaps, warns LOUDLY that the worker is down, and returns 0", async () => {
    const conv = await seedConversation();
    const gap = await seedMessage(conv.id, "user", "fill me");

    const { code, stdout, stderr } = await runMain(["--verbose"]);
    expect(code).toBe(0);

    // The worker-down WARNING (kill-switch) landed on stderr, not stdout.
    expect(stderr).toContain("WARNING: the EmbedWorker appears to be DOWN");
    expect(stderr).toContain("EZCORP_DISABLE_EMBED_WORKER");
    // --verbose done-line on stderr.
    expect(stderr).toContain('"done":true');

    // stdout is a single parseable summary doc with errors: [].
    const summary = JSON.parse(stdout);
    expect(summary.dryRun).toBe(false);
    expect(summary.enqueued).toBe(1);
    expect(summary.eligibleScanned).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(summary.backlog.pending).toBe(1);

    // The gap was actually queued.
    expect((await outboxFor(gap.id)).length).toBe(1);
  });

  test("--dry-run reports the would-enqueue count, writes nothing, returns 0", async () => {
    const conv = await seedConversation();
    await seedMessage(conv.id, "user", "gap one");
    await seedMessage(conv.id, "assistant", "gap two");

    const { code, stdout } = await runMain(["--dry-run"]);
    expect(code).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.dryRun).toBe(true);
    expect(summary.enqueued).toBe(2);
    expect((await outboxRows()).length).toBe(0);
  });

  test("a per-item enqueue failure is accumulated into errors and returns 1 (final progress still rendered)", async () => {
    const conv = await seedConversation();
    await seedMessage(conv.id, "user", "this enqueue will throw");

    // Install a BEFORE INSERT trigger that throws on every outbox insert. This
    // makes runBackfill()'s enqueue reject; main() catches it into `errors`,
    // then STILL fetches the final getEmbedProgress snapshot (which reads the
    // table fine — only INSERTs are blocked) and returns 1.
    const db = getTestDb();
    await db.execute(
      sql`CREATE OR REPLACE FUNCTION _backfill_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom-on-insert'; END; $$ LANGUAGE plpgsql;`,
    );
    await db.execute(
      sql`CREATE TRIGGER _backfill_boom_trg BEFORE INSERT ON message_embed_outbox FOR EACH ROW EXECUTE FUNCTION _backfill_boom();`,
    );

    const { code, stdout } = await runMain([]);
    expect(code).toBe(1);
    const summary = JSON.parse(stdout);
    expect(summary.errors.length).toBe(1);
    // The captured message is the drizzle "Failed query: insert into
    // message_embed_outbox ..." wrapper around the trigger's RAISE EXCEPTION.
    expect(summary.errors[0]).toContain("message_embed_outbox");
    expect(summary.enqueued).toBe(0);
    // Nothing committed despite the attempt.
    expect((await outboxRows()).length).toBe(0);
  });

  test("worker-up path: with the kill-switch cleared and a live PID lockfile, main() does NOT warn", async () => {
    delete process.env.EZCORP_DISABLE_EMBED_WORKER;
    // `DEFAULT_LOCKFILE_PATH` is the RELATIVE `.ezcorp/embed-worker.pid`, so
    // it resolves against cwd — the checkout, for a test. Writing it there
    // meant clobbering (and, when the host had none, LEAVING BEHIND) a real
    // file in the tree. Run this test from a throwaway root instead: the
    // lockfile is ours, and the save/restore dance disappears with it.
    const tmpRoot = useTempProjectRoot("backfill-lockfile-");
    const lockPath = ".ezcorp/embed-worker.pid";
    // Point the lockfile at THIS live process so isWorkerDown() → false.
    await Bun.write(lockPath, String(process.pid));
    try {
      const conv = await seedConversation();
      await seedMessage(conv.id, "user", "fill me too");
      const { code, stdout, stderr } = await runMain([]);
      expect(code).toBe(0);
      expect(stderr).not.toContain("WARNING: the EmbedWorker appears to be DOWN");
      expect(JSON.parse(stdout).enqueued).toBe(1);
    } finally {
      tmpRoot.cleanup();
    }
  });
});

describe("isWorkerDown / isProcessAlive (worker-liveness probes)", () => {
  let savedKill: string | undefined;
  beforeEach(() => {
    savedKill = process.env.EZCORP_DISABLE_EMBED_WORKER;
    delete process.env.EZCORP_DISABLE_EMBED_WORKER;
  });
  afterEach(() => {
    if (savedKill === undefined) delete process.env.EZCORP_DISABLE_EMBED_WORKER;
    else process.env.EZCORP_DISABLE_EMBED_WORKER = savedKill;
  });

  test("isProcessAlive: own PID is alive; invalid/dead PIDs are not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // Non-finite / non-positive guard.
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    // A PID extremely unlikely to exist → ESRCH → not alive.
    expect(isProcessAlive(2 ** 31 - 1)).toBe(false);
  });

  test("isWorkerDown: kill-switch env forces DOWN regardless of lockfile", async () => {
    process.env.EZCORP_DISABLE_EMBED_WORKER = "1";
    expect(await isWorkerDown()).toBe(true);
  });

  test("isWorkerDown: kill-switch=0 falls through to lockfile liveness", async () => {
    process.env.EZCORP_DISABLE_EMBED_WORKER = "0"; // not "1" → not forced down
    // Same relative-path story as the worker-up test above — own the root.
    const tmpRoot = useTempProjectRoot("backfill-lockfile-");
    const lockPath = ".ezcorp/embed-worker.pid";
    try {
      // (a) live PID → worker UP (not down).
      await Bun.write(lockPath, String(process.pid));
      expect(await isWorkerDown()).toBe(false);
      // (b) dead PID in lockfile → worker DOWN.
      await Bun.write(lockPath, "999999999");
      expect(await isWorkerDown()).toBe(true);
    } finally {
      tmpRoot.cleanup();
    }
  });
});
