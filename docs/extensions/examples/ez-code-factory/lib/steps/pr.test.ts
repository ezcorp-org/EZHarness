import { test, expect, describe } from "bun:test";
import { prStep } from "./pr";
import { makeGit } from "../git";
import { defaultPipelineConfig } from "../config";
import { emptyRepoConfig } from "../repo-config";
import { makeRunShared, type StepContext } from "./common";
import type { ShellResult } from "../shell";
import type { GhRunner } from "../github";
import type { AgentDispatcher, DispatchResult } from "../agent";
import type { StepWithRounds } from "../runs";

const ok = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" });
const err = (): ShellResult => ({ exitCode: 1, stdout: "", stderr: "no" });

interface PrCtxOptions {
  branch?: string;
  upstream?: string | null; // null → `git remote get-url origin` fails
  gh?: GhRunner;
  dispatch?: (opts: unknown) => Promise<DispatchResult> | DispatchResult;
  history?: StepWithRounds[];
  commitLog?: string;
}

function makeCtx(opts: PrCtxOptions = {}): {
  ctx: StepContext;
  logs: string[];
  prUrls: string[];
} {
  const logs: string[] = [];
  const prUrls: string[] = [];
  const worktree = "/wt";
  const hostRunner = async (cmd: string[]): Promise<ShellResult> => {
    const args = cmd.slice(3); // drop git -C <dir>
    if (args[0] === "remote" && args[1] === "get-url") {
      return opts.upstream == null ? err() : ok(opts.upstream);
    }
    if (args[0] === "log") return ok(opts.commitLog ?? "abc123 add a widget");
    if (args[0] === "diff") return ok(" file | 2 +-");
    if (args[0] === "merge-base") return err(); // → base falls back to run.baseSha
    return ok("");
  };
  const dispatcher: AgentDispatcher = {
    async dispatch(o) {
      if (opts.dispatch) return opts.dispatch(o);
      return { output: { title: "feat: add a widget", body: "## What Changed\n\n- added it" }, text: "" };
    },
  };
  const ctx: StepContext = {
    worktree,
    gateDir: "/gate.git",
    tmpBase: "/tmp",
    run: {
      id: "r1",
      branch: opts.branch ?? "feat/x",
      ref: `refs/heads/${opts.branch ?? "feat/x"}`,
      headSha: "deadbeef",
      baseSha: "1234567",
      intent: "add a widget",
      intentSource: "agent",
      prUrl: null,
    },
    repo: { defaultBranch: "main", workingPath: "/proj" },
    config: defaultPipelineConfig(),
    repoConfig: emptyRepoConfig(),
    shared: makeRunShared(),
    fixing: false,
    previousFindings: "",
    rounds: [],
    dispatcher,
    hostGit: makeGit(hostRunner, worktree),
    jailedGit: makeGit(hostRunner, worktree),
    hostRunner,
    gh: opts.gh ?? (async () => ok("")),
    now: () => 0,
    sleep: async () => {},
    log: (m) => logs.push(m),
    updateHeadSha: async () => {},
    updatePrUrl: async (url) => {
      prUrls.push(url);
    },
    loadStepHistory: async () => opts.history ?? [],
  };
  return { ctx, logs, prUrls };
}

/** A gh runner scripted by the argv (auth / pr list / pr create / pr edit). */
function scriptGh(map: {
  auth?: ShellResult;
  list?: ShellResult;
  create?: ShellResult;
  edit?: ShellResult;
}): GhRunner {
  return async (args: string[]) => {
    if (args[0] === "auth") return map.auth ?? ok("");
    if (args[0] === "pr" && args[1] === "list") return map.list ?? ok("[]");
    if (args[0] === "pr" && args[1] === "create") return map.create ?? ok("https://github.com/o/n/pull/1");
    if (args[0] === "pr" && args[1] === "edit") return map.edit ?? ok("");
    return ok("");
  };
}

describe("prStep skip conditions", () => {
  test("skips on the default branch", async () => {
    const { ctx, logs } = makeCtx({ branch: "main" });
    expect(await prStep.execute(ctx)).toEqual({ skipped: true });
    expect(logs.join()).toContain("default branch");
  });
  test("skips when upstream is not GitHub", async () => {
    const { ctx, logs } = makeCtx({ upstream: "https://gitlab.com/o/n.git" });
    expect(await prStep.execute(ctx)).toEqual({ skipped: true });
    expect(logs.join()).toContain("not a GitHub upstream");
  });
  test("skips when the origin remote is unreadable", async () => {
    const { ctx } = makeCtx({ upstream: null });
    expect(await prStep.execute(ctx)).toEqual({ skipped: true });
  });
  test("skips when gh is unauthenticated", async () => {
    const { ctx, logs } = makeCtx({
      upstream: "https://github.com/o/n.git",
      gh: scriptGh({ auth: err() }),
    });
    expect(await prStep.execute(ctx)).toEqual({ skipped: true });
    expect(logs.join()).toContain("not authenticated");
  });
});

describe("prStep create/update", () => {
  const upstream = "https://github.com/o/n.git";

  test("creates a PR and propagates the URL", async () => {
    const { ctx, prUrls, logs } = makeCtx({
      upstream,
      gh: scriptGh({ list: ok("[]"), create: ok("https://github.com/o/n/pull/5") }),
    });
    expect(await prStep.execute(ctx)).toEqual({});
    expect(prUrls).toEqual(["https://github.com/o/n/pull/5"]);
    expect(logs.join()).toContain("created pull request");
  });

  test("created PR with empty url → no propagation", async () => {
    const { ctx, prUrls } = makeCtx({ upstream, gh: scriptGh({ list: ok("[]"), create: ok("   ") }) });
    await prStep.execute(ctx);
    expect(prUrls).toEqual([]);
  });

  test("updates an existing PR", async () => {
    const { ctx, prUrls, logs } = makeCtx({
      upstream,
      gh: scriptGh({ list: ok(JSON.stringify([{ number: 3, url: "https://github.com/o/n/pull/3" }])), edit: ok("") }),
    });
    await prStep.execute(ctx);
    expect(prUrls).toEqual(["https://github.com/o/n/pull/3"]);
    expect(logs.join()).toContain("already exists");
  });

  test("update failure is a warning; keeps the existing URL", async () => {
    const { ctx, prUrls, logs } = makeCtx({
      upstream,
      gh: scriptGh({ list: ok(JSON.stringify([{ number: 3, url: "https://github.com/o/n/pull/3" }])), edit: err() }),
    });
    await prStep.execute(ctx);
    expect(prUrls).toEqual(["https://github.com/o/n/pull/3"]);
    expect(logs.join()).toContain("failed to update PR");
  });
});

describe("prStep body assembly", () => {
  const upstream = "https://github.com/o/n.git";

  test("agent content: tightened title + assembled body (Intent + What Changed)", async () => {
    let sentContent: { title: string; body: string } | null = null;
    const gh: GhRunner = async (args, opts) => {
      if (args[0] === "auth") return ok("");
      if (args[1] === "list") return ok("[]");
      if (args[1] === "create") {
        // Capture the body-file stdin.
        const titleIdx = args.indexOf("--title");
        sentContent = { title: args[titleIdx + 1]!, body: opts?.stdin ?? "" };
        return ok("https://github.com/o/n/pull/9");
      }
      return ok("");
    };
    const { ctx } = makeCtx({
      upstream,
      gh,
      dispatch: () => ({ output: { title: "add a widget", body: "## What Changed\n\n- added it" }, text: "" }),
    });
    await prStep.execute(ctx);
    expect(sentContent!.title).toBe("feat: add a widget");
    expect(sentContent!.body).toContain("## Intent");
    expect(sentContent!.body).toContain("add a widget");
    expect(sentContent!.body).toContain("## What Changed");
    expect(sentContent!.body).toContain("- added it");
  });

  test("agent output with only generated sections → fallback body from commit log", async () => {
    let body = "";
    const gh: GhRunner = async (args, opts) => {
      if (args[0] === "auth") return ok("");
      if (args[1] === "list") return ok("[]");
      if (args[1] === "create") {
        body = opts?.stdin ?? "";
        return ok("https://github.com/o/n/pull/1");
      }
      return ok("");
    };
    const { ctx } = makeCtx({
      upstream,
      gh,
      commitLog: "abc fix: the bug",
      dispatch: () => ({ output: { title: "x", body: "## Intent\n\nonly generated" }, text: "" }),
    });
    await prStep.execute(ctx);
    expect(body).toContain("## What Changed");
    expect(body).toContain("abc fix: the bug");
  });

  test("agent dispatch throws → fallback", async () => {
    const { ctx, prUrls, logs } = makeCtx({
      upstream,
      gh: scriptGh({ list: ok("[]"), create: ok("https://github.com/o/n/pull/2") }),
      dispatch: () => {
        throw new Error("model down");
      },
    });
    await prStep.execute(ctx);
    expect(prUrls).toEqual(["https://github.com/o/n/pull/2"]);
    expect(logs.join()).toContain("using fallback");
  });

  test("agent invalid output (missing body) → fallback with empty commit log uses title bullet", async () => {
    let body = "";
    const gh: GhRunner = async (args, opts) => {
      if (args[0] === "auth") return ok("");
      if (args[1] === "list") return ok("[]");
      if (args[1] === "create") {
        body = opts?.stdin ?? "";
        return ok("https://github.com/o/n/pull/1");
      }
      return ok("");
    };
    const { ctx } = makeCtx({
      upstream,
      gh,
      commitLog: "",
      dispatch: () => ({ output: { title: "feat: only title" }, text: "" }),
    });
    await prStep.execute(ctx);
    // Fallback title from empty commit log → branch "feat/x" → tightened.
    expect(body).toContain("## What Changed");
    expect(body).toContain("- ");
  });
});
