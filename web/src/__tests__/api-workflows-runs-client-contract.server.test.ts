/**
 * The CLIENT half of the run-history contract.
 *
 * `api-workflows-run-trace.server.test.ts` pins what the two routes ACCEPT
 * and RETURN. Nothing pinned what `web/src/lib/api.ts` actually sends them,
 * and that gap is invisible to every other gate at once:
 *
 * - `api.ts` is in the coverage `EXCLUDES` list, so the line gate cannot see
 *   `fetchWorkflowRuns` at all.
 * - The e2e specs answer both routes from `e2e/fixtures/api-mocks.ts`, so
 *   they prove the page renders a shape the FIXTURE invented. A fixture that
 *   ignores `limit`, or answers a bare array instead of `{ runs }`, is
 *   indistinguishable there from a server that does the same.
 *
 * So the two halves could disagree — the client asking for a `limit` the
 * route rejects with a 400, or unwrapping a key the route does not emit —
 * and every check in this repo would stay green while the workflow page
 * showed "Could not load run history" to every user.
 *
 * This file closes that by wiring the REAL client functions to the REAL
 * route handlers through a `fetch` stub, with only the two DB-backed readers
 * doubled. Nothing here invents a wire shape: the request is built by
 * `api.ts` and parsed by `+server.ts`, and a mismatch anywhere between them
 * is a failure here.
 */
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const trace = vi.hoisted(() => ({
  getWorkflowRunTrace: vi.fn(),
  listWorkflowRunsForCaller: vi.fn(),
}));
// Spread the REAL module, double only the two readers — same reasoning as
// the route suite: `RUN_PAGE_MAX` must come through untouched, because the
// client's default page size is asserted against it below.
vi.mock("$server/runtime/workflow-run-trace", async (importActual) => ({
  ...(await importActual<typeof import("$server/runtime/workflow-run-trace")>()),
  getWorkflowRunTrace: trace.getWorkflowRunTrace,
  listWorkflowRunsForCaller: trace.listWorkflowRunsForCaller,
}));

const { GET: LIST } = await import("../routes/api/workflows/runs/+server");
const { GET: ONE } = await import("../routes/api/workflows/runs/[id]/+server");
const { RUN_PAGE_MAX } = await import("$server/runtime/workflow-run-trace");
const { fetchWorkflowRuns, fetchWorkflowRunTrace } = await import("$lib/api");

/** A page as `listWorkflowRunsForCaller` really builds it — the envelope is
 *  the point, and so is the absence of `result`. */
const SUMMARY = {
  id: "9f3c1a2e-7b64-4d18-9a52-0c1e5d7f8a10",
  workflowName: "nightly",
  status: "success",
  projectId: null,
  userId: "u1",
  startedAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:00:10.000Z",
  suspendedReason: null,
  resumable: false,
  jobRef: null,
};

const TRACE = {
  run: { ...SUMMARY, result: { success: true, output: "Shipped v2." } },
  steps: [{ stepName: "draft", status: "success", iterationRows: [] }],
  totals: { inputTokens: 10, outputTokens: 2, durationMs: 5, steps: 1 },
};

const MEMBER = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

/** Every URL the client asked for, in order. */
let requests: string[] = [];
let locals: Record<string, unknown> = MEMBER;

/**
 * The transport, replaced by the routes themselves.
 *
 * `params.id` is DECODED, as SvelteKit decodes it — otherwise this stub
 * would quietly accept a client that never encoded anything.
 */
async function dispatch(input: string): Promise<Response> {
  requests.push(input);
  const url = new URL(input, "http://localhost");
  const one = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)$/);
  if (one) {
    return ONE(makeRequestEvent(url.href, { params: { id: decodeURIComponent(one[1]!) }, locals }));
  }
  if (url.pathname === "/api/workflows/runs") {
    return LIST(makeRequestEvent(url.href, { locals }));
  }
  // Not a 404: an unroutable path means the client built one no SvelteKit
  // route would ever match, which is a louder failure than "not found".
  throw new Error(`the client requested a path no route serves: ${url.pathname}`);
}

/** The URL of the request the client just made. */
function lastUrl(): URL {
  expect(requests.length).toBeGreaterThan(0);
  return new URL(requests[requests.length - 1]!, "http://localhost");
}

beforeEach(() => {
  requests = [];
  locals = MEMBER;
  trace.getWorkflowRunTrace.mockReset().mockResolvedValue(TRACE);
  trace.listWorkflowRunsForCaller.mockReset().mockResolvedValue({ runs: [SUMMARY] });
  vi.stubGlobal("fetch", (input: unknown) => dispatch(String(input)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWorkflowRuns ↔ GET /api/workflows/runs", () => {
  test("the request the workflow page makes is one the real route ACCEPTS", async () => {
    // The whole point of the file. `fetchWorkflowRuns(name)` is called with
    // one argument by `(app)/workflows/[name]/+page.svelte`, so this is
    // byte-for-byte the request that page issues on mount. If the route
    // rejected any part of it the client would throw here instead of
    // returning rows.
    const rows = await fetchWorkflowRuns("nightly");

    expect(lastUrl().pathname).toBe("/api/workflows/runs");
    expect(lastUrl().searchParams.get("workflowName")).toBe("nightly");
    expect(lastUrl().searchParams.get("limit")).toBe("25");
    // ...and the route understood it as a filter, rather than dropping an
    // unrecognized parameter and answering with every workflow's history.
    expect(trace.listWorkflowRunsForCaller).toHaveBeenCalledWith(
      { workflowName: "nightly", limit: 25 },
      { userId: "u1", isAdmin: false },
    );
    expect(rows).toEqual([SUMMARY]);
  });

  test("the default page size is inside the range the ROUTE enforces", async () => {
    // Pinned against the real `RUN_PAGE_MAX` rather than against the number
    // 25, so raising or lowering the server's cap re-checks the client
    // instead of silently invalidating this. A default of 0, 500 or 25.5
    // makes the route answer 400 and the page render its error line.
    await fetchWorkflowRuns("nightly");
    const limit = Number(lastUrl().searchParams.get("limit"));
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(limit).toBeLessThanOrEqual(RUN_PAGE_MAX);
  });

  test("a caller-supplied limit reaches the route as a NUMBER, not a string", async () => {
    // `URLSearchParams` stringifies everything; the route is what parses it
    // back. `limit: "5"` would pass `Number.isInteger` never and 400.
    await fetchWorkflowRuns("nightly", 5);
    expect(trace.listWorkflowRunsForCaller).toHaveBeenCalledWith(
      { workflowName: "nightly", limit: 5 },
      { userId: "u1", isAdmin: false },
    );
  });

  test("a workflow name with URL metacharacters arrives INTACT", async () => {
    // Workflow names are free text. Built by string concatenation, the `&`
    // here splits into a second parameter and the `#` truncates the rest —
    // the route would then filter on "release notes" and answer with
    // another workflow's runs under this one's heading.
    const name = "release notes & more/v2?x=1#frag";
    await fetchWorkflowRuns(name);
    expect(trace.listWorkflowRunsForCaller).toHaveBeenCalledWith(
      { workflowName: name, limit: 25 },
      { userId: "u1", isAdmin: false },
    );
  });

  test("the ENVELOPE is unwrapped: the page gets rows, not the page object", async () => {
    // The route answers `{ runs, nextCursor }`. `mergeRunHistory` iterates
    // what it is handed, so an envelope reaching it yields an empty history
    // with no error anywhere.
    trace.listWorkflowRunsForCaller.mockResolvedValue({
      runs: [SUMMARY],
      nextCursor: { startedAt: "2026-07-01T00:00:00.000Z", id: SUMMARY.id },
    });
    const rows = await fetchWorkflowRuns("nightly");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([SUMMARY]);
    expect(rows).not.toHaveProperty("runs");
  });

  test("a body without `runs` yields an empty ARRAY, never undefined", async () => {
    // Defensive, and load-bearing: the page feeds this straight into
    // `mergeRunHistory`, which iterates it. `undefined` there is a TypeError
    // during render — a blank page rather than an empty history.
    trace.listWorkflowRunsForCaller.mockResolvedValue({} as never);
    await expect(fetchWorkflowRuns("nightly")).resolves.toEqual([]);
  });

  test("the LIST projection carries no result — which is why a trace is fetched at all", async () => {
    // The page's whole Output disclosure exists because of this. If the
    // list ever grew a `result`, the per-row round trip would be dead code
    // and this test is where that gets noticed.
    const [row] = await fetchWorkflowRuns("nightly");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("result");
    expect(row).not.toHaveProperty("input");
  });

  test("a refusal surfaces the SERVER's message, which is what the page paints", async () => {
    // `run-history-error` renders `e.message`. A client that dropped the
    // body would show the bare "403 Forbidden" status line instead.
    locals = { ...MEMBER, apiKeyScopes: ["chat"] };
    await expect(fetchWorkflowRuns("nightly")).rejects.toThrow("Insufficient scope");
    expect(trace.listWorkflowRunsForCaller).not.toHaveBeenCalled();
  });
});

describe("fetchWorkflowRunTrace ↔ GET /api/workflows/runs/[id]", () => {
  test("returns the run's RESULT, the field the list projection omits", async () => {
    const got = await fetchWorkflowRunTrace(SUMMARY.id);
    expect(lastUrl().pathname).toBe(`/api/workflows/runs/${SUMMARY.id}`);
    expect(trace.getWorkflowRunTrace).toHaveBeenCalledWith(SUMMARY.id, {
      userId: "u1",
      isAdmin: false,
    });
    // `runOutput(trace.run.result)` is exactly what both surfaces render.
    expect(got.run.result).toEqual({ success: true, output: "Shipped v2." });
  });

  test("the run id is ENCODED, so it cannot smuggle a path or a query", async () => {
    // Unencoded, `?` ends the path and the route reads `params.id` as the
    // part before it — answering with a DIFFERENT run's trace, including
    // its `resolved_input`. `#` truncates it the same way, and a `/` builds
    // a path no route serves at all.
    const id = "9f3c1a2e?id=someone-elses";
    await fetchWorkflowRunTrace(id);
    expect(lastUrl().search).toBe("");
    expect(trace.getWorkflowRunTrace).toHaveBeenCalledWith(id, expect.anything());
  });

  test("an unreadable run throws the route's 404 text verbatim", async () => {
    // What `run-output-error` shows in the row. 404 covers both "gone" and
    // "not yours"; the client must not decorate it into something that
    // distinguishes them.
    trace.getWorkflowRunTrace.mockResolvedValue(undefined);
    await expect(fetchWorkflowRunTrace(SUMMARY.id)).rejects.toThrow("Not found");
  });
});

/**
 * `web/src/lib/api.ts` re-declares `WorkflowRunSummary` because the client
 * bundle cannot import from `src/`. Two hand-written copies of one wire
 * shape drift, and the drift is silent: a field the server drops stays in
 * the client type as `string`, and every consumer keeps type-checking
 * against a value that is now `undefined` at runtime.
 *
 * Parsed rather than imported — importing the server module from a test
 * that also feeds the vitest coverage leg is fine, but the client interface
 * is a TYPE and erases at runtime, so the source is the only place the two
 * can be compared at all.
 */
describe("WorkflowRunSummary — one wire shape, two declarations", () => {
  // `import.meta.dirname`, not a cwd-relative path: the vitest leg is
  // invoked from `web/` by one script and from the repo root by another.
  const HERE = (import.meta as unknown as { dirname: string }).dirname;

  function fields(file: string, name: string): string[] {
    const source = readFileSync(file, "utf8")
      // Comments can carry `word:` and would be read as fields.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const head = `export interface ${name} {`;
    const start = source.indexOf(head);
    expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
    const body = source.slice(start + head.length, source.indexOf("\n}", start));
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!).sort();
  }

  test("the client's copy names exactly the server's fields", () => {
    const client = fields(resolve(HERE, "../lib/api.ts"), "WorkflowRunSummary");
    const server = fields(
      resolve(HERE, "../../../src/runtime/workflow-run-trace.ts"),
      "WorkflowRunSummary",
    );
    // Guards the extractor itself: a regex that matched nothing would make
    // two empty lists compare equal.
    expect(server).toContain("startedAt");
    expect(client).toEqual(server);
  });
});
