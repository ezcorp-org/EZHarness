// ── Document step — unit tests (document.go port) ───────────────────

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHostRunner } from "../shell";
import { makeGit } from "../git";
import { defaultPipelineConfig, type PipelineConfig } from "../config";
import { emptyRepoConfig, type RepoConfig } from "../repo-config";
import { deserializeFindings, type Findings } from "../runs";
import { HOUSEKEEPING_FINDINGS_SCHEMA, FINDINGS_SCHEMA } from "../prompts";
import type { AgentDispatcher, DispatchOptions, DispatchResult } from "../agent";
import { makeRunShared, type RunShared, type StepContext } from "./common";
import {
  documentStep,
  splitHousekeepingFindings,
  documentApprovalOutcome,
  hasNonIgnoredDocumentChanges,
  fallbackDocumentSummary,
  extractDocumentSummary,
  validateRequiredFindings,
} from "./document";

const sh = (args: string[], cwd: string) => productionHostRunner(args, cwd);

async function initRepo(dir: string): Promise<void> {
  await sh(["git", "init", "-b", "main", dir], dir);
  await sh(["git", "config", "user.email", "t@t.com"], dir);
  await sh(["git", "config", "user.name", "t"], dir);
  await sh(["git", "config", "commit.gpgsign", "false"], dir);
}

async function commit(dir: string, file: string, content: string, message: string): Promise<string> {
  writeFileSync(join(dir, file), content);
  await sh(["git", "add", "-A"], dir);
  await sh(["git", "commit", "-m", message], dir);
  return (await sh(["git", "rev-parse", "HEAD"], dir)).stdout.trim();
}

function fakeDispatcher(impl: (o: DispatchOptions) => DispatchResult): AgentDispatcher & { calls: DispatchOptions[] } {
  const calls: DispatchOptions[] = [];
  return {
    calls,
    async dispatch(o) {
      calls.push(o);
      return impl(o);
    },
  };
}

interface Over {
  run?: Partial<StepContext["run"]>;
  repoConfig?: RepoConfig;
  config?: PipelineConfig;
  previousFindings?: string;
  dispatcher?: AgentDispatcher;
  shared?: RunShared;
}

// ── pure helpers ────────────────────────────────────────────────────

describe("document pure helpers", () => {
  test("splitHousekeepingFindings routes by category; uncategorized → documentation", () => {
    const findings: Findings = deserializeFindings({
      findings: [
        { id: "d1", severity: "warning", description: "doc gap", action: "ask-user", category: "documentation" },
        { id: "l1", severity: "warning", description: "lint", action: "auto-fix", category: "lint" },
        { id: "u1", severity: "info", description: "unlabeled", action: "no-op" },
      ],
      summary: "s",
    });
    const [doc, lint] = splitHousekeepingFindings(findings);
    expect(doc.items.map((i) => i.id)).toEqual(["d1", "u1"]);
    expect(lint.items.map((i) => i.id)).toEqual(["l1"]);
  });

  test("hasNonIgnoredDocumentChanges", () => {
    expect(hasNonIgnoredDocumentChanges("a.txt\nb.snap", ["*.snap"])).toBe(true);
    expect(hasNonIgnoredDocumentChanges("b.snap\n", ["*.snap"])).toBe(false);
    expect(hasNonIgnoredDocumentChanges("  \n", [])).toBe(false);
  });

  test("fallbackDocumentSummary + extractDocumentSummary", () => {
    expect(fallbackDocumentSummary("  ")).toBe("agent returned no structured output");
    expect(fallbackDocumentSummary(" hi ")).toBe("hi");
    expect(extractDocumentSummary({ summary: "done" }, "fb")).toBe("done");
    expect(extractDocumentSummary({ summary: "  " }, "fb")).toBe("fb");
    expect(extractDocumentSummary(null, "fb")).toBe("fb");
  });

  test("validateRequiredFindings enforces summary + per-finding required fields", () => {
    expect(validateRequiredFindings(null).ok).toBe(false);
    expect(validateRequiredFindings({ findings: [], summary: "" }).ok).toBe(false);
    expect(validateRequiredFindings({ summary: "s" }).ok).toBe(false); // no findings/items
    expect(validateRequiredFindings({ findings: [{ severity: "", description: "d", action: "no-op" }], summary: "s" }).ok).toBe(false);
    expect(validateRequiredFindings({ findings: [{ severity: "info", description: "", action: "no-op" }], summary: "s" }).ok).toBe(false);
    expect(validateRequiredFindings({ findings: [{ severity: "info", description: "d", action: "" }], summary: "s" }).ok).toBe(false);
    const okRes = validateRequiredFindings({ items: [{ severity: "info", description: "d", action: "no-op" }], summary: "s" });
    expect(okRes.ok).toBe(true);
  });

  test("documentApprovalOutcome parks an ask-user warning", () => {
    const outcome = documentApprovalOutcome("uncertain");
    expect(outcome.needsApproval).toBe(true);
    const f = deserializeFindings(JSON.parse(outcome.findings!));
    expect(f.items[0]!.action).toBe("ask-user");
  });
});

// ── the step ────────────────────────────────────────────────────────

describe("documentStep", () => {
  let dir: string;
  let head: string;
  let base: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-doc-"));
    await initRepo(dir);
    base = await commit(dir, "a.txt", "one\n", "base");
    // The change lands on a feature branch off main, so merge-base(HEAD, main) is
    // the base and the branch diff is coherent (base..head = the changed file).
    await sh(["git", "checkout", "-b", "feature"], dir);
    head = await commit(dir, "b.txt", "two\n", "change");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeCtx(over: Over = {}): { ctx: StepContext; logs: string[] } {
    const logs: string[] = [];
    const ctx: StepContext = {
      worktree: dir,
      gateDir: dir,
      tmpBase: join(dir, ".tmp"),
      run: {
        id: "run_1",
        branch: "feature",
        ref: "refs/heads/feature",
        headSha: head,
        baseSha: base,
        intent: null,
        intentSource: null,
        ...over.run,
      },
      repo: { defaultBranch: "main", workingPath: "" },
      config: over.config ?? defaultPipelineConfig(),
      repoConfig: over.repoConfig ?? emptyRepoConfig(),
      shared: over.shared ?? makeRunShared(),
      fixing: false,
      previousFindings: over.previousFindings ?? "",
      rounds: [],
      dispatcher: over.dispatcher ?? fakeDispatcher(() => ({ output: { findings: [], summary: "ok" }, text: "" })),
      hostGit: makeGit(productionHostRunner, dir),
      jailedGit: makeGit(productionHostRunner, dir),
      hostRunner: productionHostRunner,
      log: (m) => logs.push(m),
      updateHeadSha: async () => {},
    };
    return { ctx, logs };
  }

  test("no non-ignored changes → skipped (empty outcome), stash cleared", async () => {
    const shared = makeRunShared();
    shared.setHousekeepingLint({ findingsJson: "{}", summary: "stale" });
    const { ctx, logs } = makeCtx({ shared, run: { headSha: base } }); // diff base..base = empty
    const outcome = await documentStep.execute(ctx);
    expect(outcome).toEqual({});
    expect(logs.join()).toContain("no changes to document");
    // combined mode cleared the pre-existing stash before the change check.
    expect(shared.takeHousekeepingLint()).toBeNull();
  });

  test("combined mode (no lint command): housekeeping schema, doc findings park, lint half stashed", async () => {
    const dispatcher = fakeDispatcher(() => ({
      output: {
        findings: [
          { id: "d1", severity: "warning", description: "stale doc", action: "ask-user", category: "documentation" },
          { id: "l1", severity: "warning", description: "lint issue", action: "auto-fix", category: "lint" },
        ],
        summary: "housekeeping",
      },
      text: "",
    }));
    const shared = makeRunShared();
    const { ctx } = makeCtx({ dispatcher, shared });
    const outcome = await documentStep.execute(ctx);
    expect(dispatcher.calls[0]!.jsonSchema).toBe(HOUSEKEEPING_FINDINGS_SCHEMA);
    expect(outcome.needsApproval).toBe(true); // a doc finding remains
    const doc = deserializeFindings(JSON.parse(outcome.findings!));
    expect(doc.items.map((i) => i.id)).toEqual(["d1"]);
    // The lint half was stashed for the lint step.
    const stash = shared.takeHousekeepingLint();
    expect(stash).not.toBeNull();
    expect(deserializeFindings(JSON.parse(stash!.findingsJson)).items[0]!.id).toBe("l1");
  });

  test("configured lint command → NOT combined (plain findings schema, no stash)", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: { findings: [], summary: "ok" }, text: "" }));
    const shared = makeRunShared();
    const repoConfig = { ...emptyRepoConfig(), commands: { test: "", lint: "biome check", format: "" } };
    const { ctx } = makeCtx({ dispatcher, shared, repoConfig });
    const outcome = await documentStep.execute(ctx);
    expect(dispatcher.calls[0]!.jsonSchema).toBe(FINDINGS_SCHEMA);
    expect(outcome.needsApproval).toBe(false);
    expect(shared.takeHousekeepingLint()).toBeNull();
  });

  test("missing structured output → parks for approval", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: null, text: "opaque" }));
    const { ctx } = makeCtx({ dispatcher });
    const outcome = await documentStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
    expect(deserializeFindings(JSON.parse(outcome.findings!)).items[0]!.action).toBe("ask-user");
  });

  test("unparseable structure (missing summary) → parks for approval", async () => {
    const dispatcher = fakeDispatcher(() => ({ output: { findings: [] }, text: "" }));
    const { ctx } = makeCtx({ dispatcher });
    const outcome = await documentStep.execute(ctx);
    expect(outcome.needsApproval).toBe(true);
  });

  test("trusted document.instructions are injected into the prompt", async () => {
    let prompt = "";
    const dispatcher = fakeDispatcher((o) => {
      prompt = o.prompt;
      return { output: { findings: [], summary: "ok" }, text: "" };
    });
    const repoConfig = { ...emptyRepoConfig(), document: { instructions: "OWNER: docs/x.md" } };
    const { ctx } = makeCtx({ dispatcher, repoConfig });
    await documentStep.execute(ctx);
    expect(prompt).toContain("Repository documentation ownership policy (trusted, from the default branch");
    expect(prompt).toContain("OWNER: docs/x.md");
  });

  test("previous findings are threaded into the prompt", async () => {
    let prompt = "";
    const dispatcher = fakeDispatcher((o) => {
      prompt = o.prompt;
      return { output: { findings: [], summary: "ok" }, text: "" };
    });
    const previousFindings = JSON.stringify({
      findings: [{ id: "d1", severity: "warning", description: "old gap", action: "ask-user" }],
      summary: "prior",
    });
    const { ctx } = makeCtx({ dispatcher, previousFindings });
    await documentStep.execute(ctx);
    expect(prompt).toContain("Previous findings to address:");
    expect(prompt).toContain("old gap");
  });

  test("a pushed-branch ignore pattern (repoConfig) filters the change → skipped", async () => {
    // The only changed file is b.txt; a pushed ignore pattern for it → no changes.
    const repoConfig = { ...emptyRepoConfig(), ignorePatterns: ["b.txt"] };
    const { ctx, logs } = makeCtx({ repoConfig });
    const outcome = await documentStep.execute(ctx);
    expect(outcome).toEqual({});
    expect(logs.join()).toContain("no changes to document");
  });

  test("a failing changed-files diff surfaces as a step error", async () => {
    const { ctx } = makeCtx({ run: { headSha: "nonexistentref" } });
    await expect(documentStep.execute(ctx)).rejects.toThrow(/get changed files:/);
  });

  test("a dispatch failure surfaces as a step error", async () => {
    const dispatcher = fakeDispatcher(() => {
      throw new Error("agent boom");
    });
    const { ctx } = makeCtx({ dispatcher });
    await expect(documentStep.execute(ctx)).rejects.toThrow(/agent document: agent boom/);
  });
});
