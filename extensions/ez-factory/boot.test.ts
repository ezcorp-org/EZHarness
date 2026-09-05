/**
 * ez-factory — production-wiring coverage for the subprocess entrypoint.
 *
 * `lib/tools/*.test.ts` drive the tools against an in-memory `FactoryFs`,
 * which by construction never executes the REAL adapter in `index.ts` —
 * the binding between the tools and the host's reverse-RPC. That adapter
 * is this extension's contract with the host, and a rename or a dropped
 * option there is a silent production break no fake-fs test can see. So it
 * is covered here IN-process, the same shape as
 * `extensions/lessons-distiller/boot.test.ts` and
 * `extensions/memory-extractor/boot.test.ts`:
 *
 *   - `mock.module("@ezcorp/sdk/runtime", …)` BEFORE importing `./index`
 *     spreads the REAL module and replaces only the `fs*` helpers with
 *     recorders, so `toolResult` / `toolError` stay real.
 *   - `getChannel` / `createToolDispatcher` are inert spies, so `start()`
 *     runs without opening stdin.
 *
 * `restoreModuleMocks()` in `afterAll` hands the real module back.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "@ezcorp/sdk/test";
import * as realRuntime from "@ezcorp/sdk/runtime";

afterAll(() => {
  restoreModuleMocks();
});

interface RpcCall {
  method: string;
  args: unknown[];
}
let rpc: RpcCall[] = [];
let registered: Record<string, unknown> | null = null;
let channelStarted = false;
let toolContext: { projectRoot?: string; conversationId?: string } | undefined;
let readReturnsBinary = false;

/** Page definitions `definePage` received, and the ids `invalidatePage`
 *  dropped — the 8.6 surface's half of the production wiring. */
let pages: Array<{ id: string; render: unknown; actions?: Record<string, unknown> }> = [];
let invalidated: string[] = [];

/** Backing store for the mocked `ezcorp/storage` RPC, so the job store and
 *  the audit log run for real against an in-memory bucket. */
let storage = new Map<string, unknown>();

// ── The mocked `ezcorp/workflows` half of the channel ──────────────
//
// The console's Run action and its run reconcile are BOTH reverse-RPCs
// on this method, so a channel that only understood `ezcorp/storage`
// could not exercise either. These stand in for the host's `op: "run"`
// and `op: "runs"`.

/** Every `op: "run"` payload the console sent, in order. */
let triggered: Array<Record<string, unknown>> = [];
/** What the mocked host answers `op: "runs"` with. */
let hostRunList: unknown[] = [];
/** When set, `op: "run"` rejects with this — the host's typed refusal. */
let triggerRejection: Error | null = null;
/** When set, `op: "runs"` rejects with this. */
let runsRejection: Error | null = null;
/** When true, `op: "runs"` answers with a body carrying NO `runs` array. */
let runsBodyMalformed = false;

const workflowsRequest = (params: unknown): unknown => {
  const p = (params ?? {}) as Record<string, unknown>;
  if (p.op === "runs") {
    if (runsRejection) throw runsRejection;
    return runsBodyMalformed ? { v: 1 } : { v: 1, runs: hostRunList };
  }
  if (triggerRejection) throw triggerRejection;
  triggered.push(p);
  return { v: 1, workflow: `ez-factory:${String(p.workflow)}`, started: true };
};

const record = (method: string, ...args: unknown[]): void => {
  rpc.push({ method, args });
};

/** The storage half of the channel's `request`, matching the host handler's
 *  wire contract (`storage-handler.ts`). */
const storageRequest = (params: unknown): unknown => {
  const p = params as Record<string, unknown>;
  const key = String(p.key ?? "");
  switch (p.action) {
    case "set":
      storage.set(key, JSON.parse(JSON.stringify(p.value)));
      return { ok: true, sizeBytes: 1 };
    case "delete":
      return { deleted: storage.delete(key) };
    case "list": {
      const prefix = typeof p.prefix === "string" ? p.prefix : "";
      return { keys: [...storage.keys()].filter((k) => k.startsWith(prefix)) };
    }
    default:
      return storage.has(key)
        ? { value: storage.get(key), exists: true }
        : { value: null, exists: false };
  }
};

mock.module("@ezcorp/sdk/runtime", () => ({
  ...realRuntime,
  createToolDispatcher: (handlers: Record<string, unknown>) => {
    registered = handlers;
  },
  definePage: (def: { id: string; render: unknown; actions?: Record<string, unknown> }) => {
    pages.push(def);
  },
  invalidatePage: (pageId: string) => {
    invalidated.push(pageId);
  },
  getChannel: () => ({
    start: () => {
      channelStarted = true;
    },
    request: async (method: string, params: unknown) =>
      method === "ezcorp/workflows" ? workflowsRequest(params) : storageRequest(params),
    onRequest: () => {},
    notify: () => {},
  }),
  getToolContext: () => toolContext,
  fsList: async (path: string) => {
    record("fsList", path);
    return [{ name: "a.md", isFile: true, isDirectory: false }];
  },
  fsStat: async (path: string) => {
    record("fsStat", path);
    return { size: 5, mtimeMs: 0, isFile: true, isDirectory: false, resolvedPath: path };
  },
  fsRead: async (path: string, opts?: { encoding?: string }) => {
    record("fsRead", path, opts);
    return readReturnsBinary ? new TextEncoder().encode("hello") : "hello";
  },
  fsWrite: async (path: string, content: string) => {
    record("fsWrite", path, content);
    return { bytes: content.length, resolvedPath: path };
  },
  fsMkdir: async (path: string, opts?: { recursive?: boolean }) => {
    record("fsMkdir", path, opts);
    return { resolvedPath: path };
  },
  fsExists: async (path: string) => {
    record("fsExists", path);
    return false;
  },
}));

const {
  __resetStateForTests,
  activeConversationId,
  activeProjectRoot,
  auditLog,
  deps,
  handleJobRun,
  handleJobSave,
  hostFs,
  jobStore,
  reconcileRuns,
  recentRuns,
  registerPages,
  renderFactoryPage,
  renderJobPage,
  start,
} = await import("./index");

beforeEach(() => {
  rpc = [];
  registered = null;
  channelStarted = false;
  toolContext = { projectRoot: "/active-project" };
  readReturnsBinary = false;
  pages = [];
  invalidated = [];
  storage = new Map();
  triggered = [];
  hostRunList = [];
  triggerRejection = null;
  runsRejection = null;
  runsBodyMalformed = false;
  __resetStateForTests();
});

describe("boot", () => {
  test("registers the three tools and starts the channel", () => {
    start();
    expect(Object.keys(registered ?? {}).sort()).toEqual(
      ["emit_artifact", "read_files", "write_file"].sort(),
    );
    expect(channelStarted).toBe(true);
  });

  test("start also mounts both Hub pages", () => {
    // The 8.6 half of production wiring: a page the entrypoint never
    // registers renders nothing, and the failure is a 404 at pull time
    // rather than anything this extension's own tests would see.
    start();
    expect(pages.map((p) => p.id).sort()).toEqual(["factory", "job"]);
  });

  test("the registered handlers are live against the real host adapter", async () => {
    start();
    const readFiles = registered?.["read_files"] as (
      args: unknown,
    ) => Promise<{ isError: boolean; content: Array<{ text: string }> }>;

    const result = await readFiles({ globs: ["**/*.md"] });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      files: Array<{ path: string; content: string }>;
    };
    expect(payload.files.map((f) => f.path)).toEqual(["a.md"]);
    // The sanitizer ran on the real path, not just in the unit tests.
    expect(payload.files[0]?.content).toContain("-----BEGIN UNTRUSTED INPUT-----");
    expect(rpc.map((c) => c.method)).toEqual(["fsList", "fsStat", "fsRead"]);
  });
});

describe("the host-mediated fs adapter", () => {
  test("list forwards the path", async () => {
    await hostFs.list("/p/dir");
    expect(rpc).toEqual([{ method: "fsList", args: ["/p/dir"] }]);
  });

  test("stat projects only the size the tools need", async () => {
    expect(await hostFs.stat("/p/a.md")).toEqual({ size: 5 });
  });

  test("read asks for utf-8 and returns a string", async () => {
    expect(await hostFs.read("/p/a.md")).toBe("hello");
    expect(rpc[0]).toEqual({ method: "fsRead", args: ["/p/a.md", { encoding: "utf-8" }] });
  });

  test("read decodes a Uint8Array rather than casting it", async () => {
    // `fsRead` is typed `string | Uint8Array` because the same RPC serves
    // binary reads. A cast would put "[object Uint8Array]" into an agent
    // prompt.
    readReturnsBinary = true;
    expect(await hostFs.read("/p/a.md")).toBe("hello");
  });

  test("write reports the host's byte count", async () => {
    expect(await hostFs.write("/p/a.md", "abc")).toEqual({ bytes: 3 });
    expect(rpc).toEqual([{ method: "fsWrite", args: ["/p/a.md", "abc"] }]);
  });

  test("mkdir is recursive — a run's artifact directory has no parent yet", async () => {
    await hostFs.mkdir("/p/deep/dir");
    expect(rpc).toEqual([{ method: "fsMkdir", args: ["/p/deep/dir", { recursive: true }] }]);
  });

  test("exists forwards the path", async () => {
    expect(await hostFs.exists("/p/a.md")).toBe(false);
    expect(rpc).toEqual([{ method: "fsExists", args: ["/p/a.md"] }]);
  });
});

describe("activeConversationId", () => {
  test("forwards the host's conversation coordinate", () => {
    // Inside a workflow this is the synthetic `workflow-run:<uuid>` scope
    // key, which is how `emit_artifact` learns its run id without an
    // argument no template could supply (there is no `$run.*` ref root).
    toolContext = { conversationId: "workflow-run:abc-123" };
    expect(activeConversationId()).toBe("workflow-run:abc-123");
    expect(deps.conversationId()).toBe("workflow-run:abc-123");
  });

  test("is undefined for an out-of-band dispatch with no tool context", () => {
    toolContext = undefined;
    expect(activeConversationId()).toBeUndefined();
  });
});

describe("activeProjectRoot", () => {
  test("prefers the per-call tool context", () => {
    // One persistent subprocess serves every conversation, so a
    // process-wide env var names only ever ONE project.
    toolContext = { projectRoot: "/active-project" };
    expect(activeProjectRoot()).toBe("/active-project");
    expect(deps.projectRoot()).toBe("/active-project");
  });

  test("falls back to EZCORP_PROJECT_ROOT for an out-of-band dispatch", () => {
    // A workflow tool step carries a synthetic conversation with no
    // project to resolve, so this is the branch that actually runs there.
    toolContext = undefined;
    withEnv({ EZCORP_PROJECT_ROOT: "/env-project" }, () => {
      expect(activeProjectRoot()).toBe("/env-project");
    });
  });

  test("falls back to EZCORP_EXTENSION_DATA_ROOT before ever reaching cwd", () => {
    // THE branch that runs in production. `registry.ts` leaves
    // `EZCORP_PROJECT_ROOT` unset whenever `findProjectRoot()` throws — and
    // that same absence leaves `getSpawnCwd()` undefined, so the subprocess
    // inherits the host's cwd, which is `web/` (dev) / `/app/web` (prod).
    // Reaching `process.cwd()` there makes `read_files` walk the SvelteKit
    // frontend and report its files as project-root-relative, authorized
    // the whole way because `web/` is inside the `$CWD` grant.
    //
    // `EZCORP_EXTENSION_DATA_ROOT` is always injected, and from the SAME
    // `getProjectRoot()` that `grantCwdBase()` expands `$CWD` through.
    toolContext = undefined;
    withEnv(
      { EZCORP_PROJECT_ROOT: undefined, EZCORP_EXTENSION_DATA_ROOT: "/data-root" },
      () => {
        expect(activeProjectRoot()).toBe("/data-root");
        expect(activeProjectRoot()).not.toBe(process.cwd());
      },
    );
  });

  test("EZCORP_PROJECT_ROOT still wins over the data root when both are set", () => {
    toolContext = undefined;
    withEnv(
      { EZCORP_PROJECT_ROOT: "/env-project", EZCORP_EXTENSION_DATA_ROOT: "/data-root" },
      () => {
        expect(activeProjectRoot()).toBe("/env-project");
      },
    );
  });

  test("falls back to the process cwd as a last resort", () => {
    toolContext = undefined;
    withEnv(
      { EZCORP_PROJECT_ROOT: undefined, EZCORP_EXTENSION_DATA_ROOT: undefined },
      () => {
        expect(activeProjectRoot()).toBe(process.cwd());
      },
    );
  });
});

/** Run `fn` with `vars` applied to `process.env`, restoring every key
 *  afterwards. `undefined` means "delete for the duration". */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Hub page wiring (8.6) ───────────────────────────────────────────
//
// The pure builders are covered in `lib/page.test.ts`. What is covered here
// is the GLUE: that each page id maps to the right builder, that the render
// reads the store, and that the one action writes through the validator and
// audits what it did. None of that is visible to a test that calls the
// builders directly.

describe("page registration", () => {
  test("both pages share one registration of each namespaced action", () => {
    // Two handlers, two mount points, mounted on BOTH page ids. That is
    // not tidiness: the Hub POSTs an action tagged with the page it was
    // rendered on, so an action reachable from one page and handled only
    // on the other is a silent no-op. Every name here also needs a grant
    // — `ezcorp.config.test.ts` pins the manifest against `PAGE_EVENTS`.
    registerPages();
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.flatMap((page) => Object.keys(page.actions ?? {})).sort()).toEqual(
      ["ez-factory:job-run", "ez-factory:job-save"],
    );
  });
});

describe("renderFactoryPage", () => {
  test("an empty install renders the jobs view's empty state", async () => {
    const tree = await renderFactoryPage();
    expect(tree.title).toBe("ez-factory");
    expect(JSON.stringify(tree.nodes)).toContain("No jobs yet");
  });

  test("reads saved jobs out of the store", async () => {
    await handleJobSave({
      source: "hub",
      pageId: "job",
      userId: "user-1",
      payload: { name: "Docs", workflow: "docs-factory", input_globs: "src/**" },
    });
    const tree = await renderFactoryPage();
    expect(JSON.stringify(tree.nodes)).toContain("Docs");
  });

  test("`?view=` selects the surface, and an unknown one is an empty state", async () => {
    expect(JSON.stringify((await renderFactoryPage({ view: "templates" })).nodes)).toContain(
      "docs-factory",
    );
    expect(JSON.stringify((await renderFactoryPage({ view: "runs" })).nodes)).toContain(
      "No runs recorded",
    );
    expect(JSON.stringify((await renderFactoryPage({ view: "nonsense" })).nodes)).toContain(
      "Unknown view",
    );
  });

  test("a project-scoped render keeps its links inside that project's hub", async () => {
    const tree = await renderFactoryPage({
      project: { id: "p1", name: "P", path: "/p" },
    });
    expect(JSON.stringify(tree.nodes)).toContain("/project/p1/hub/");
  });

  test("the GLOBAL hub's project LIST addresses nothing, so links stay global", async () => {
    // `ctx.projects` is every project; a page-level href needs one project
    // or none. Picking one arbitrarily would send viewers into a project
    // they may not have been looking at.
    const tree = await renderFactoryPage({
      projects: [{ id: "p1", name: "P", path: "/p" }],
    });
    expect(JSON.stringify(tree.nodes)).not.toContain("/project/p1/hub/");
  });
});

describe("renderJobPage", () => {
  test("no view renders the create form", async () => {
    const tree = await renderJobPage();
    expect(tree.title).toBe("ez-factory — job");
    expect(JSON.stringify(tree.nodes)).toContain("Create job");
  });

  test("`job:<id>` loads that job from the store and prefills it", async () => {
    await handleJobSave({
      source: "hub",
      pageId: "job",
      userId: "user-1",
      payload: { name: "Loaded", workflow: "docs-factory" },
    });
    const id = (await jobStore().listJobs())[0]!.id;
    const tree = await renderJobPage({ view: `job:${id}` });
    expect(JSON.stringify(tree.nodes)).toContain("Loaded");
    expect(JSON.stringify(tree.nodes)).toContain("Save job");
  });

  test("an id that resolves to nothing renders 'not found', never a create form", async () => {
    const tree = await renderJobPage({ view: "job:missing" });
    expect(JSON.stringify(tree.nodes)).toContain("Job not found");
    expect(JSON.stringify(tree.nodes)).not.toContain("Create job");
  });
});

describe("recentRuns", () => {
  test("interleaves per-job indexes newest-first and bounds the result", async () => {
    await jobStore().recordRun({
      jobId: "a", workflowRunId: "r1", workflowName: "w",
      status: "completed", startedAt: "2026-08-01T01:00:00.000Z",
      finishedAt: null, suspendedReason: null, resumable: false,
    });
    await jobStore().recordRun({
      jobId: "b", workflowRunId: "r2", workflowName: "w",
      status: "completed", startedAt: "2026-08-01T03:00:00.000Z",
      finishedAt: null, suspendedReason: null, resumable: false,
    });
    // `recentRuns` reads nothing but `.id`, so an id-only stub is the
    // honest fixture; the double cast is what lets it stand in for the
    // full `FactoryJob` without inventing fields the function never
    // touches.
    const jobs = [{ id: "a" }, { id: "b" }] as unknown as Parameters<typeof recentRuns>[0];
    expect((await recentRuns(jobs)).map((r) => r.workflowRunId)).toEqual(["r2", "r1"]);
    // Bounded: a hundred jobs cannot produce a tree the host's node/byte
    // caps would reject wholesale.
    expect(await recentRuns(jobs, 1)).toHaveLength(1);
  });
});

describe("handleJobSave", () => {
  const save = (payload: Record<string, unknown>) =>
    handleJobSave({ source: "hub", pageId: "job", userId: "user-7", payload });

  test("a valid create writes the job and audits the create by id", async () => {
    await save({ name: "Docs", workflow: "docs-factory", input_globs: "src/**" });

    const jobs = await jobStore().listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe("Docs");
    expect(jobs[0]!.input).toEqual({ globs: "src/**" });
    // Attribution the host will accept, written but never acted on.
    expect(jobs[0]!.createdBy).toBe("user-7");

    const day = await auditLog().readDay(new Date().toISOString().slice(0, 10));
    expect(day.map((e) => (e as { kind: string }).kind)).toEqual(["job-create"]);
    expect((day[0] as { jobId: string }).jobId).toBe(jobs[0]!.id);
  });

  test("an edit replaces the job and audits the CHANGED FIELD NAMES only", async () => {
    await save({ name: "Docs", workflow: "docs-factory", input_globs: "src/**" });
    const id = (await jobStore().listJobs())[0]!.id;

    const secret = "CONFIDENTIAL draft body";
    await save({
      job_id: id,
      name: "Docs",
      workflow: "draft-and-verify",
      input_draft: secret,
    });

    const jobs = await jobStore().listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.workflow).toBe("draft-and-verify");

    const day = await auditLog().readDay(new Date().toISOString().slice(0, 10));
    const saveEntry = day.find((e) => (e as { kind: string }).kind === "job-save")!;
    expect((saveEntry as { detail: { changed: string[] } }).detail.changed).toEqual([
      "input",
      "workflow",
    ]);
    // INVARIANT I: the value never reaches the durable trail.
    expect(JSON.stringify(day)).not.toContain(secret);
  });

  test("a REJECTED draft writes nothing and is audited by reason", async () => {
    // The Hub gives a page action no error channel, so the alternative to
    // recording a refusal is that it leaves no trace anywhere.
    await save({ name: "", workflow: "docs-factory" });
    expect(await jobStore().listJobs()).toHaveLength(0);
    const day = await auditLog().readDay(new Date().toISOString().slice(0, 10));
    expect(day.map((e) => (e as { kind: string }).kind)).toEqual(["job-rejected"]);
  });

  test("an input outside the workflow's allowlist is REFUSED, not silently dropped", async () => {
    // Invariant B reaching the console: `needsReview` could resolve a gate
    // step's `when` to false. The form cannot offer it, and the handler
    // does not get to accept it either.
    await save({ name: "J", workflow: "docs-factory", input_needsreview: "false" });
    // The unknown input field is not in the reverse map, so it never
    // becomes an input key at all — the job saves WITHOUT it.
    const jobs = await jobStore().listJobs();
    expect(jobs[0]!.input).toEqual({});
  });

  test("a save against a vanished job is audited as missing, not recreated", async () => {
    await save({ job_id: "ghost", name: "X", workflow: "docs-factory" });
    expect(await jobStore().listJobs()).toHaveLength(0);
    const day = await auditLog().readDay(new Date().toISOString().slice(0, 10));
    expect(day.map((e) => (e as { kind: string }).kind)).toEqual(["job-missing"]);
  });

  test("both pages are invalidated after a write", async () => {
    // `invalidatePage`, not `pushPage`: these are perProject pages, so one
    // pushed tree could not cover the global and per-project variants.
    await save({ name: "Docs", workflow: "docs-factory" });
    expect(invalidated.sort()).toEqual(["factory", "job"]);
  });

  test("the store and audit log are singletons across calls", async () => {
    expect(jobStore()).toBe(jobStore());
    expect(auditLog()).toBe(auditLog());
  });
});

// ── The Run action, and the correlation it makes possible ────────────
//
// This is the half the console shipped without: everything above could
// DESCRIBE work, and nothing could start it. What is covered here is the
// glue no pure-builder test can reach — that a click reaches the host's
// trigger with the right handle on it, that a refusal is written down
// rather than swallowed, and that the host's answer to `op: "runs"` folds
// back into the store the runs view reads.

/** Create one job through the real save path and return it. */
async function seedJob(
  payload: Record<string, unknown> = { name: "Nightly", workflow: "docs-factory" },
): Promise<{ id: string; name: string }> {
  await handleJobSave({ source: "hub", pageId: "job", userId: "user-1", payload });
  const job = (await jobStore().listJobs())[0]!;
  return { id: job.id, name: job.name };
}

/** Every audit entry recorded, oldest first. */
async function auditEntries(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const day of await auditLog().listDays()) {
    // A bucket holds `AuditEntry | AuditTruncationMarker`; the tests below
    // read them structurally, so widen through `unknown` rather than
    // asserting an overlap the union does not have.
    for (const e of await auditLog().readDay(day)) {
      out.push(e as unknown as Record<string, unknown>);
    }
  }
  return out;
}

/** The reason on the most recent entry of `kind`, or undefined. */
async function reasonFor(kind: string): Promise<string | undefined> {
  const entry = (await auditEntries()).reverse().find((e) => e.kind === kind);
  const detail = entry?.detail as { reason?: string } | undefined;
  return detail?.reason;
}

const runAction = (payload: Record<string, unknown>) =>
  handleJobRun({ source: "hub", pageId: "job", userId: "user-7", payload });

describe("handleJobRun", () => {
  test("fires the job's workflow with its saved input AND its id as jobRef", async () => {
    const job = await seedJob({
      name: "Nightly",
      workflow: "docs-factory",
      input_globs: "src/**/*.ts",
      input_outpath: "docs/api.md",
    });

    // `job_id` — the key the ACTION PAYLOAD actually carries (the host's
    // field-id rule forbids `jobId`). A reader keyed on the camelCase form
    // refuses every real click in silence, which is exactly what shipped
    // until a live server caught it.
    await runAction({ job_id: job.id });

    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toMatchObject({
      v: 1,
      workflow: "docs-factory",
      input: { globs: "src/**/*.ts", outPath: "docs/api.md" },
      // The whole point: the host is told WHICH JOB this run belongs to.
      // Without it the run is unattributable and `op: "runs"` can only be
      // matched by timestamp, which is wrong the moment two jobs fire
      // together.
      jobRef: job.id,
    });
  });

  test("the camelCase key fires NOTHING — the wire key is job_id", async () => {
    const job = await seedJob();
    await runAction({ jobId: job.id });
    expect(triggered).toEqual([]);
    expect(await reasonFor("job-run-rejected")).toContain("no valid job id");
  });

  test("records a `job-run` audit line naming the workflow and no input values", async () => {
    const job = await seedJob({
      name: "Nightly",
      workflow: "docs-factory",
      input_outpath: "docs/secret-layout.md",
    });
    await runAction({ job_id: job.id });

    const entry = (await auditEntries()).find((e) => e.kind === "job-run");
    expect(entry).toBeDefined();
    expect(entry?.jobId).toBe(job.id);
    expect(entry?.detail).toEqual({ workflow: "docs-factory" });
    // Invariant I: a path describing someone's project layout is content,
    // and content never enters the trail.
    expect(JSON.stringify(entry)).not.toContain("secret-layout");
  });

  test("invalidates both pages so the next pull re-renders", async () => {
    const job = await seedJob();
    invalidated = [];
    await runAction({ job_id: job.id });
    expect(invalidated.sort()).toEqual(["factory", "job"]);
  });

  test("does NOT stamp lastRunAt — the run has no start time yet", async () => {
    // The trigger RPC returns BEFORE `insertWorkflowRun`, so the only
    // honest start time is the host's. Writing the click time would put a
    // timestamp on the job that no run ever had.
    const job = await seedJob();
    await runAction({ job_id: job.id });
    expect((await jobStore().getJob(job.id))?.lastRunAt).toBeUndefined();
  });

  describe("refusals — each audited by reason, each firing nothing", () => {
    test("a payload with no valid job id", async () => {
      await runAction({ job_id: "not a job id!" });
      expect(triggered).toEqual([]);
      expect(await reasonFor("job-run-rejected")).toContain("no valid job id");
    });

    test("a job id that resolves to nothing", async () => {
      await runAction({ job_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
      expect(triggered).toEqual([]);
      expect(await reasonFor("job-run-rejected")).toBe("job not found");
    });

    test("a DISABLED job — `enabled:false` is this console's retire", async () => {
      const job = await seedJob({ name: "Retired", workflow: "docs-factory", enabled: "no" });
      await runAction({ job_id: job.id });
      expect(triggered).toEqual([]);
      expect(await reasonFor("job-run-rejected")).toBe("job is disabled");
    });

    test("a stored job the validator no longer accepts", async () => {
      // The per-workflow input allowlist is a SECURITY control — a job must
      // not be able to set a key a template's gate reads in a `when`. The
      // store only accepts branded drafts, so this row is reachable only by
      // writing storage directly; re-validating at the point of SPEND is
      // what makes writing storage insufficient.
      const job = await seedJob();
      const stored = storage.get(`job:${job.id}`) as Record<string, unknown>;
      storage.set(`job:${job.id}`, { ...stored, input: { skipDependents: "false" } });

      await runAction({ job_id: job.id });

      expect(triggered).toEqual([]);
      const reason = await reasonFor("job-run-rejected");
      expect(reason).toContain("no longer valid");
      expect(reason).toContain("skipDependents");
    });

    test("the host's own refusal is recorded, not swallowed", async () => {
      // A hub action has no error channel back to the clicker — the route
      // answers `{ok:true}` the moment the notification is sent. An
      // unrecorded refusal is one nobody can ever learn about.
      const job = await seedJob();
      triggerRejection = new Error("workflow trigger quota exceeded");
      await runAction({ job_id: job.id });
      const reason = await reasonFor("job-run-rejected");
      expect(reason).toContain("host refused");
      expect(reason).toContain("quota exceeded");
    });
  });
});

describe("reconcileRuns", () => {
  const hostRun = (over: Record<string, unknown> = {}) => ({
    workflowRunId: "11111111-2222-3333-4444-555555555555",
    workflowName: "ez-factory:docs-factory",
    status: "running",
    startedAt: "2026-08-02T10:00:00.000Z",
    finishedAt: null,
    suspendedReason: null,
    resumable: false,
    jobRef: null,
    ...over,
  });

  test("folds a host run back into the store when it names a known job", async () => {
    const job = await seedJob();
    hostRunList = [hostRun({ jobRef: job.id })];

    const records = await reconcileRuns(await jobStore().listJobs());

    expect(records).toHaveLength(1);
    // `recordRun` finally has a caller on the real path.
    const stored = await jobStore().listRuns(job.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.workflowRunId).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("writes the job's bookkeeping from the HOST's start time", async () => {
    const job = await seedJob();
    hostRunList = [hostRun({ jobRef: job.id })];
    await reconcileRuns(await jobStore().listJobs());
    const after = await jobStore().getJob(job.id);
    expect(after?.lastRunAt).toBe("2026-08-02T10:00:00.000Z");
    expect(after?.lastWorkflowRunId).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("keeps the NEWEST run per job, whatever order the host returned", async () => {
    const job = await seedJob();
    hostRunList = [
      hostRun({
        jobRef: job.id,
        workflowRunId: "11111111-1111-1111-1111-111111111111",
        startedAt: "2026-08-02T09:00:00.000Z",
      }),
      hostRun({
        jobRef: job.id,
        workflowRunId: "22222222-2222-2222-2222-222222222222",
        startedAt: "2026-08-02T11:00:00.000Z",
      }),
    ];
    await reconcileRuns(await jobStore().listJobs());
    expect((await jobStore().getJob(job.id))?.lastWorkflowRunId).toBe(
      "22222222-2222-2222-2222-222222222222",
    );
  });

  test("ignores a run this console did not start", async () => {
    // No `jobRef` ⇒ a hand-fired REST run or a CLI run. Claiming it would
    // put a run in the console the console never started.
    await seedJob();
    hostRunList = [hostRun({ jobRef: null })];
    expect(await reconcileRuns(await jobStore().listJobs())).toEqual([]);
  });

  test("ignores a run naming a job that is gone", async () => {
    await seedJob();
    hostRunList = [hostRun({ jobRef: "99999999-9999-9999-9999-999999999999" })];
    expect(await reconcileRuns(await jobStore().listJobs())).toEqual([]);
  });

  test("no jobs ⇒ no host read at all", async () => {
    runsRejection = new Error("should never be asked");
    expect(await reconcileRuns([])).toEqual([]);
  });

  test("a refused read degrades to the last known state and is audited", async () => {
    const job = await seedJob();
    runsRejection = new Error("Rate limited");
    expect(await reconcileRuns(await jobStore().listJobs())).toEqual([]);
    expect(await reasonFor("runs-read-failed")).toContain("Rate limited");
    // The job survived untouched — a failed poll is not a state change.
    expect((await jobStore().getJob(job.id))?.lastRunAt).toBeUndefined();
  });

  test("a malformed response body degrades instead of throwing out of a render", async () => {
    // A `runs()` body with no array would otherwise throw through
    // `renderFactoryPage` and turn the whole console into "This page
    // failed to render".
    await seedJob();
    runsBodyMalformed = true;
    expect(await reconcileRuns(await jobStore().listJobs())).toEqual([]);
  });

  test("the runs VIEW reconciles before it reads, so one look is enough", async () => {
    const job = await seedJob();
    hostRunList = [hostRun({ jobRef: job.id, status: "success" })];
    const tree = await renderFactoryPage({ view: "runs" });
    // Reconcile-then-read: reading first would show "No runs recorded" on
    // the first look and the run on the second, which reads as a bug.
    const json = JSON.stringify(tree.nodes);
    expect(json).not.toContain("No runs recorded");
    expect(json).toContain(job.name);
    expect(json).toContain("success");
  });

  test("the templates view does no host read at all", async () => {
    await seedJob();
    runsRejection = new Error("should never be asked");
    const tree = await renderFactoryPage({ view: "templates" });
    expect(JSON.stringify(tree.nodes)).toContain("draft-and-verify");
  });
});
