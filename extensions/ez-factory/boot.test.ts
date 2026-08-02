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
import { restoreModuleMocks } from "../../src/__tests__/helpers/mock-cleanup";
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
    request: async (_method: string, params: unknown) => storageRequest(params),
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
  handleJobSave,
  hostFs,
  jobStore,
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
    const previous = process.env.EZCORP_PROJECT_ROOT;
    process.env.EZCORP_PROJECT_ROOT = "/env-project";
    try {
      expect(activeProjectRoot()).toBe("/env-project");
    } finally {
      if (previous === undefined) delete process.env.EZCORP_PROJECT_ROOT;
      else process.env.EZCORP_PROJECT_ROOT = previous;
    }
  });

  test("falls back to the process cwd as a last resort", () => {
    toolContext = undefined;
    const previous = process.env.EZCORP_PROJECT_ROOT;
    delete process.env.EZCORP_PROJECT_ROOT;
    try {
      expect(activeProjectRoot()).toBe(process.cwd());
    } finally {
      if (previous !== undefined) process.env.EZCORP_PROJECT_ROOT = previous;
    }
  });
});

// ── Hub page wiring (8.6) ───────────────────────────────────────────
//
// The pure builders are covered in `lib/page.test.ts`. What is covered here
// is the GLUE: that each page id maps to the right builder, that the render
// reads the store, and that the one action writes through the validator and
// audits what it did. None of that is visible to a test that calls the
// builders directly.

describe("page registration", () => {
  test("both pages carry the SAME single save action, namespaced", () => {
    // One handler, two mount points: the editor is reachable from either
    // page id, and a second action name would need a second grant.
    registerPages();
    for (const page of pages) {
      expect(Object.keys(page.actions ?? {})).toEqual(["ez-factory:job-save"]);
    }
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
    const jobs = [{ id: "a" }, { id: "b" }] as Parameters<typeof recentRuns>[0];
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
