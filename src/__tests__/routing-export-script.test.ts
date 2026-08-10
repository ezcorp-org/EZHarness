/**
 * WS7 — `scripts/routing-export.ts`, the labelled-sample JSONL export.
 *
 * Two layers, both asserted:
 *   - the PURE layer (`parseExportArgs`, `runExport` over injected deps) — the
 *     JSONL contract and the "exclusions are always COUNTED even when not
 *     emitted" rule;
 *   - the DB layer (`listConversationIds`, `loadLabelMessages`, `main`) against a
 *     REAL PGlite, because the thing most likely to break silently is the
 *     mapping from a `messages` row (+ its attachments) onto `LabelMessage`.
 *
 * Harness mirrors `routing-analytics.test.ts`: the shared PGlite helper, raw
 * inserts (NOT `createMessage`, which would enqueue embed jobs we don't want).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { users, projects, conversations, messages, messageAttachments } from "../db/schema";
import type { LabelMessage, ModelFacts, ModelFactsResolver } from "../runtime/routing/labels";

const {
  buildModelFactsResolver,
  listConversationIds,
  loadLabelMessages,
  main,
  parseExportArgs,
  runExport,
} = await import("../../scripts/routing-export");

const USER_ID = "u-export";
const PROJECT_ID = "p-export";
const CONV_LIVE = "conv-export-live";
const CONV_OLD = "conv-export-old";

const BASE = Date.now() - 60 * 60 * 1000;
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const LONG_AGO = new Date(BASE - 90 * 24 * 60 * 60 * 1000);

function signals(over: Record<string, unknown> = {}) {
  return {
    promptChars: 40,
    historyChars: 0,
    historyMessageCount: 0,
    hasToolMessages: false,
    systemChars: 0,
    attachmentCount: 0,
    toolCount: 0,
    hasComplexTools: false,
    estTokens: 100,
    tier: "fast",
    reason: "short-turn",
    ...over,
  };
}

/** Captured stdout/stderr around one `main` invocation. */
async function captureMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out, err };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  await db.insert(users).values({
    id: USER_ID,
    email: "e@x.com",
    passwordHash: "x",
    name: "E",
    role: "admin",
  } as any);
  await db.insert(projects).values({ id: PROJECT_ID, name: "e", path: "/tmp/e" } as any);
  for (const id of [CONV_LIVE, CONV_OLD]) {
    await db.insert(conversations).values({ id, projectId: PROJECT_ID, userId: USER_ID } as any);
  }

  // conv-live: u1 → a1(haiku, routed) → u2(+image) → a2(opus, routed). The
  // switch is capability-driven (haiku takes no images), so a1 must EXCLUDE.
  // Plus a legacy row with no usage at all.
  await db.insert(messages).values([
    { id: "u1", conversationId: CONV_LIVE, role: "user", content: "hi", createdAt: at(0) },
    {
      id: "a1",
      conversationId: CONV_LIVE,
      role: "assistant",
      content: "hello",
      parentMessageId: "u1",
      provider: "anthropic",
      model: "claude-haiku-4-5-20250514",
      usage: { inputTokens: 10, outputTokens: 5, requestedModel: null, routingSignals: signals() },
      createdAt: at(1),
    },
    {
      id: "u2",
      conversationId: CONV_LIVE,
      role: "user",
      content: "and this?",
      parentMessageId: "a1",
      createdAt: at(2),
    },
    {
      id: "a2",
      conversationId: CONV_LIVE,
      role: "assistant",
      content: "sure",
      parentMessageId: "u2",
      provider: "anthropic",
      model: "claude-opus-4-5",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        requestedModel: null,
        routingSignals: signals({ tier: "powerful" }),
      },
      createdAt: at(3),
    },
    {
      id: "a-legacy",
      conversationId: CONV_LIVE,
      role: "assistant",
      content: "old",
      parentMessageId: "a2",
      provider: "anthropic",
      model: "claude-opus-4-5",
      createdAt: at(4),
    },
  ] as any);
  await db.insert(messageAttachments).values([
    {
      id: "att-1",
      messageId: "u2",
      conversationId: CONV_LIVE,
      filename: "shot.png",
      mimeType: "image/png",
      sizeBytes: 100,
      storagePath: "/tmp/shot.png",
      kind: "image",
    },
  ] as any);

  // conv-old: entirely outside every window under test.
  await db.insert(messages).values([
    { id: "o-u1", conversationId: CONV_OLD, role: "user", content: "old", createdAt: LONG_AGO },
    {
      id: "o-a1",
      conversationId: CONV_OLD,
      role: "assistant",
      content: "old",
      parentMessageId: "o-u1",
      provider: "anthropic",
      model: "claude-haiku-4-5-20250514",
      usage: { inputTokens: 1, outputTokens: 1, requestedModel: null, routingSignals: signals() },
      createdAt: LONG_AGO,
    },
  ] as any);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("parseExportArgs", () => {
  test("defaults to a 30-day window that emits only labelled classes", () => {
    expect(parseExportArgs([])).toEqual({ days: 30, includeExcluded: false });
  });

  test("accepts every flag", () => {
    expect(
      parseExportArgs([
        "--days",
        "90",
        "--conversation",
        "c1",
        "--out",
        "x.jsonl",
        "--include-excluded",
      ]),
    ).toEqual({ days: 90, conversationId: "c1", out: "x.jsonl", includeExcluded: true });
  });

  test("--days floors a fractional value", () => {
    expect(parseExportArgs(["--days", "7.9"])).toMatchObject({ days: 7 });
  });

  test("rejects a bad --days rather than silently defaulting", () => {
    expect(parseExportArgs(["--days", "0"])).toEqual({ error: "--days needs a positive number" });
    expect(parseExportArgs(["--days", "nope"])).toEqual({
      error: "--days needs a positive number",
    });
    expect(parseExportArgs(["--days"])).toEqual({ error: "--days needs a positive number" });
  });

  test("rejects a valueless --conversation / --out", () => {
    expect(parseExportArgs(["--conversation"])).toEqual({ error: "--conversation needs an id" });
    expect(parseExportArgs(["--out"])).toEqual({ error: "--out needs a path" });
  });

  test("rejects an unknown flag", () => {
    expect(parseExportArgs(["--nope"])).toEqual({ error: 'unknown flag "--nope"' });
  });
});

describe("runExport — the JSONL contract", () => {
  const FACTS: Record<string, ModelFacts> = {
    "anthropic fast": {
      tier: "fast",
      contextWindow: 1_000,
      acceptedMimeTypes: new Set(["text/plain"]),
    },
    "anthropic strong": {
      tier: "powerful",
      contextWindow: 1_000,
      acceptedMimeTypes: new Set(["text/plain"]),
    },
  };
  const resolveModelFacts: ModelFactsResolver = (p, m) => FACTS[`${p} ${m}`];

  /** u1 → a1(fast) → u2 → a2(strong): a1 escalated (negative), a2 abandoned. */
  function thread(conversationId: string): LabelMessage[] {
    const sig = signals() as LabelMessage["usage"] extends null ? never : any;
    return [
      {
        id: `${conversationId}-u1`,
        role: "user",
        parentMessageId: null,
        createdAt: at(0).toISOString(),
      },
      {
        id: `${conversationId}-a1`,
        role: "assistant",
        parentMessageId: `${conversationId}-u1`,
        createdAt: at(1).toISOString(),
        provider: "anthropic",
        model: "fast",
        usage: { routingSignals: sig },
      },
      {
        id: `${conversationId}-u2`,
        role: "user",
        parentMessageId: `${conversationId}-a1`,
        createdAt: at(2).toISOString(),
      },
      {
        id: `${conversationId}-a2`,
        role: "assistant",
        parentMessageId: `${conversationId}-u2`,
        createdAt: at(3).toISOString(),
        provider: "anthropic",
        model: "strong",
        usage: { routingSignals: sig },
      },
    ];
  }

  function deps(lines: string[], ids: string[]) {
    return {
      conversationIds: async () => ids,
      loadConversation: async (id: string) => thread(id),
      resolveModelFacts,
      emit: (line: string) => lines.push(line),
    };
  }

  test("emits one JSON object per labelled sample and counts the exclusions", async () => {
    const lines: string[] = [];
    const summary = await runExport({ days: 30, includeExcluded: false }, deps(lines, ["c1"]));
    expect(lines).toHaveLength(1);
    const sample = JSON.parse(lines[0]!);
    expect(sample).toMatchObject({
      conversationId: "c1",
      messageId: "c1-a1",
      label: "negative",
      reason: "switch-escalated",
      servedProvider: "anthropic",
      servedModel: "fast",
      servedTier: "fast",
      comparedToModel: "strong",
      comparedToTier: "powerful",
    });
    expect(sample.signals.estTokens).toBe(100);
    // The excluded turn was NOT emitted but IS counted — the rule that keeps a
    // capability-churn-dominated dataset visible.
    expect(summary).toEqual({
      days: 30,
      conversations: 1,
      emitted: 1,
      counts: {
        positive: 0,
        negative: 1,
        excluded: 1,
        byReason: { "switch-escalated": 1, abandoned: 1 },
      },
    });
  });

  test("--include-excluded emits the audit rows too", async () => {
    const lines: string[] = [];
    const summary = await runExport({ days: 30, includeExcluded: true }, deps(lines, ["c1"]));
    expect(lines).toHaveLength(2);
    expect(summary.emitted).toBe(2);
    expect(JSON.parse(lines[1]!).label).toBe("excluded");
  });

  test("--conversation skips the window scan entirely", async () => {
    let scanned = 0;
    const lines: string[] = [];
    const summary = await runExport(
      { days: 30, includeExcluded: false, conversationId: "only-me" },
      {
        conversationIds: async () => {
          scanned += 1;
          return ["c1", "c2"];
        },
        loadConversation: async (id) => thread(id),
        resolveModelFacts,
        emit: (line) => lines.push(line),
      },
    );
    expect(scanned).toBe(0);
    expect(summary.conversations).toBe(1);
    expect(JSON.parse(lines[0]!).conversationId).toBe("only-me");
  });

  test("many conversations accumulate into one tally", async () => {
    const lines: string[] = [];
    const summary = await runExport(
      { days: 30, includeExcluded: false },
      deps(lines, ["c1", "c2", "c3"]),
    );
    expect(summary).toMatchObject({ conversations: 3, emitted: 3 });
    expect(summary.counts.negative).toBe(3);
    expect(summary.counts.excluded).toBe(3);
  });

  test("no conversations ⇒ an empty, zeroed summary", async () => {
    const lines: string[] = [];
    const summary = await runExport({ days: 30, includeExcluded: false }, deps(lines, []));
    expect(lines).toEqual([]);
    expect(summary).toEqual({
      days: 30,
      conversations: 0,
      emitted: 0,
      counts: { positive: 0, negative: 0, excluded: 0, byReason: {} },
    });
  });
});

describe("the DB layer", () => {
  test("listConversationIds finds conversations inside the window only", async () => {
    expect(await listConversationIds(30)).toEqual([CONV_LIVE]);
    // Widen far enough and the archived conversation appears.
    expect(await listConversationIds(365)).toEqual([CONV_LIVE, CONV_OLD]);
  });

  test("loadLabelMessages maps rows + attachment MIMEs onto LabelMessage", async () => {
    const rows = await loadLabelMessages(CONV_LIVE);
    expect(rows.map((r) => r.id)).toEqual(["u1", "a1", "u2", "a2", "a-legacy"]);
    const u2 = rows.find((r) => r.id === "u2");
    expect(u2?.attachmentMimeTypes).toEqual(["image/png"]);
    const a1 = rows.find((r) => r.id === "a1");
    expect(a1?.provider).toBe("anthropic");
    expect(a1?.usage?.routingSignals?.tier).toBe("fast");
    // Rows with no attachments get an empty list, not undefined.
    expect(rows.find((r) => r.id === "u1")?.attachmentMimeTypes).toEqual([]);
  });

  test("buildModelFactsResolver reports the registry tier, window and MIMEs", () => {
    const resolve = buildModelFactsResolver();
    const facts = resolve("anthropic", "claude-opus-4-5");
    expect(facts).toBeDefined();
    expect(facts?.contextWindow).toBeGreaterThan(0);
    expect(facts?.acceptedMimeTypes.has("text/plain")).toBe(true);
    // Memoised: the same object comes back for a repeat lookup.
    expect(resolve("anthropic", "claude-opus-4-5")).toBe(facts);
  });
});

describe("main — end to end against the seeded DB", () => {
  test("JSONL on stdout, summary on stderr, and the capability switch EXCLUDED", async () => {
    const { code, out, err } = await captureMain([
      "--conversation",
      CONV_LIVE,
      "--include-excluded",
    ]);
    expect(code).toBe(0);
    const emitted = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(emitted.map((s) => s.messageId)).toEqual(["a1", "a2", "a-legacy"]);
    // THE assertion this whole file exists for: a haiku→opus switch on a turn
    // whose prompt carried an image is capability-driven, never an escalation.
    expect(emitted[0]).toMatchObject({ label: "excluded", reason: "capability-attachment" });
    expect(emitted[2]).toMatchObject({ label: "excluded", reason: "no-routing-signals" });
    const summary = JSON.parse(err.trim());
    expect(summary).toMatchObject({ conversations: 1, emitted: 3 });
    expect(summary.counts.negative).toBe(0);
  });

  test("without --include-excluded nothing is emitted here, but the tally still reports", async () => {
    const { code, out, err } = await captureMain(["--conversation", CONV_LIVE]);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(JSON.parse(err.trim())).toMatchObject({ emitted: 0 });
    expect(JSON.parse(err.trim()).counts.excluded).toBe(3);
  });

  test("--out writes the JSONL to a file and puts the summary on stdout", async () => {
    const path = `/tmp/ez-routing-export-${crypto.randomUUID()}.jsonl`;
    const { code, out } = await captureMain([
      "--conversation",
      CONV_LIVE,
      "--include-excluded",
      "--out",
      path,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ out: path, emitted: 3 });
    const written = await Bun.file(path).text();
    expect(written.trim().split("\n")).toHaveLength(3);
    await Bun.file(path).delete();
  });

  test("a full-window run scans the window itself", async () => {
    const { code, err } = await captureMain(["--days", "30", "--include-excluded"]);
    expect(code).toBe(0);
    expect(JSON.parse(err.trim())).toMatchObject({ days: 30, conversations: 1 });
  });

  test("a bad flag exits 2 with the reason on stderr and writes nothing", async () => {
    const { code, out, err } = await captureMain(["--bogus"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain('unknown flag "--bogus"');
  });
});
