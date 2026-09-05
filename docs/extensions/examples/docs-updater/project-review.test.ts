import { expect, test } from "bun:test";
import { createRuntimeExtension } from "@ezcorp/sdk/v4";
import { createToolDispatcher, type LoopCompleteContext } from "@ezcorp/sdk/runtime";
import type { DocsOutcome } from "./index";

async function exercise(options: { files?: string[]; action?: "finalize" | "close"; decision?: Record<string, unknown>; reviewUrl?: string } = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const extension = await createRuntimeExtension({
    manifest: { schemaVersion: 4, name: "review-test", version: "1.0.0", description: "Review test", author: { name: "Test" }, permissions: { shell: true }, tools: [{ name: "complete", description: "Complete", inputSchema: { type: "object" } }] },
    register: async () => {
      const { docsUpdaterOnComplete, buildDashboard } = await import("./index");
      createToolDispatcher({ complete: async () => {
        const context: LoopCompleteContext<DocsOutcome> = { run: { id: "run-1", loopId: "docs-updater", scope: "global", status: "drafting", events: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", input: { headHash: "a".repeat(40), subjects: [] } }, status: "completed", resultPreview: "PR #7", settings: { auto_merge: true, repo_path: "/untrusted" }, log: () => {} };
        const result = await docsUpdaterOnComplete(context);
        let value: unknown = result;
        if (result.kind === "proposal") {
          if (options.action === "finalize") value = await result.finalize();
          else if (options.action === "close") { await result.discard?.(); value = { closed: true }; }
          else value = { proposal: result.proposal, dashboard: buildDashboard([{ ...context.run, status: "awaiting_approval", proposal: result.proposal }]).build() };
        }
        return { isError: false, content: [{ type: "text", text: JSON.stringify(value) }] };
      } });
    },
  });
  const invoke = () => extension.invoke("complete", {}, {
    invocation: { invocationId: "review", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "project", token: "test", deadline: Date.now() + 5000 }, signal: new AbortController().signal,
    call: async (method, input) => {
      calls.push({ method, input });
      if (method === "ezcorp/project.origin") return "https://github.com/owner/repo.git";
      const action = (input as { action: string }).action;
      if (action === "files") return { files: options.files ?? ["docs/guide.md"], unavailable: false };
      if (action === "propose") return { proposalId: "proposal-1", reviewUrl: options.reviewUrl ?? "/extensions/project-proposals/proposal-1" };
      return options.decision ?? { state: "pending" };
    },
  });
  return { invoke, calls };
}

test("host review link is visible and no child repo path reaches the broker", async () => {
  const { invoke, calls } = await exercise();
  const result = await invoke();
  expect(JSON.stringify(result)).toContain("/extensions/project-proposals/proposal-1");
  expect(calls).toEqual([{ method: "ezcorp/project.origin", input: {} }, { method: "ezcorp/project.pullRequest", input: { action: "files", number: 7 } }, { method: "ezcorp/project.pullRequest", input: { action: "propose", number: 7, merge: true, runId: "run-1" } }]);
});

test("out-of-scope draft is not closed without a host decision", async () => {
  const { invoke, calls } = await exercise({ files: ["src/secrets.ts"] });
  expect(JSON.stringify(await invoke())).toContain('\\"closed\\":false');
  expect(calls).toHaveLength(2);
});

for (const action of ["finalize", "close"] as const) {
  for (const state of ["pending", "rejected", "failed"]) test(`${action} refuses ${state} host review`, async () => {
    const { invoke } = await exercise({ action, decision: { state } });
    const result = await invoke();
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain(`Host review is ${state}`);
  });
  test(`${action} records only a matching completed host operation`, async () => {
    const { invoke, calls } = await exercise({ action, decision: { state: "completed", action, result: { marked: action === "close" ? "closed" : "ready" } } });
    expect(await invoke()).toMatchObject({ isError: false });
    expect(calls.at(-1)).toEqual({ method: "ezcorp/project.pullRequest", input: { action, proposalId: "proposal-1" } });
  });
}

test("foreign host review links are refused", async () => {
  const { invoke } = await exercise({ reviewUrl: "https://attacker.example/review" });
  const result = await invoke();
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain("Invalid host review response");
});

test("a completed close cannot be recorded as an approved merge", async () => {
  const { invoke } = await exercise({ action: "finalize", decision: { state: "completed", action: "close", result: { marked: "closed" } } });
  const result = await invoke();
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain("no matching completed finalize");
});
