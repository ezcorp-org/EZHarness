/**
 * The shipped `extension-author.workflow.yaml` authoring chain, run through
 * the REAL loader + executor against a fake tool runner that stands in for
 * the extension-author subprocess.
 *
 * The two properties that matter:
 *   1. The happy path terminalizes `awaiting_approval` — never `success` —
 *      because the final `install_draft` step hits `ezcorp:extension:install`,
 *      which always prompts and can never be answered inside a workflow. And
 *      the parked run still carries the {draftId, userId, verifyResult}
 *      handoff so a human can finish it.
 *   2. Both gates assert real things and explain themselves when they fail.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { WorkflowExecutor, parseToolOutput } from "../runtime/workflow-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { loadYamlWorkflows } from "../runtime/workflow-loader";
import { createExtensionPermissionGate } from "../runtime/tools/permissions";
import type { AgentEvents, WorkflowDefinition } from "../types";
import type { ToolCallResult } from "../extensions/types";
import type { WorkflowToolRunner } from "../runtime/workflow-tool-runner";

const agentsDir = join(import.meta.dir, "../agents");

let chain: WorkflowDefinition;

beforeAll(async () => {
  const all = await loadYamlWorkflows(agentsDir);
  const found = all.find((w) => w.name === "extension-author");
  if (!found) throw new Error("extension-author.workflow.yaml did not load");
  chain = found;
});

const json = (v: unknown): ToolCallResult => ({
  content: [{ type: "text", text: JSON.stringify(v) }],
  isError: false,
});

interface StubOpts {
  /** What `create_extension` returns. */
  scaffold?: unknown;
  /** What `validate_extension` returns. */
  verify?: unknown;
}

/**
 * Stands in for the extension-author subprocess. `install_draft` opens a
 * real permission gate exactly like the host does for a sensitive
 * capability — inside a workflow scope that gate is refused synchronously,
 * which is the mechanism under test.
 */
function stubRunner(opts: StubOpts = {}) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const runner: WorkflowToolRunner = {
    setCurrentUserId() {},
    async executeToolCall(toolName, input, conversationId) {
      calls.push({ tool: toolName, input });
      if (toolName === "extension-author__create_extension") {
        return json(
          opts.scaffold ?? {
            draftId: "draft-abc",
            openUrl: "/extensions/author?prefill=draft-abc",
            name: input.name,
            type: input.type,
          },
        );
      }
      if (toolName === "extension-author__validate_extension") {
        return json(
          opts.verify ?? {
            ok: true,
            pass: true,
            steps: [{ name: "manifest", ok: true, detail: "valid" }],
          },
        );
      }
      if (toolName === "extension-author__install_draft") {
        await createExtensionPermissionGate({
          promptId: `p-${crypto.randomUUID()}`,
          conversationId,
          userId: "user-1",
          extensionId: "extension-author",
          toolName: "install_draft",
          // `"fs.write"` — NOT `"ezcorp:extension:install"` — because
          // `executeToolCall` collapses all four SENSITIVE_KINDS to the two
          // the always-allow persistence layer keys on before opening the
          // gate (see the caveat on `ExtensionPermissionRequest.capabilityKind`).
          // This stub reproduces the real host's collapse so the error
          // message asserted below is the one production actually emits.
          capabilityKind: "fs.write",
        });
        return json({ ok: true });
      }
      throw new Error(`Unknown tool: ${toolName}`);
    },
  };
  return { runner, calls };
}

function executorWith(opts: StubOpts = {}) {
  const bus = new EventBus<AgentEvents>();
  const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
  const stub = stubRunner(opts);
  return {
    wf: new WorkflowExecutor(agentExec, bus, { toolRunnerFactory: () => stub.runner }),
    calls: stub.calls,
  };
}

const INPUT = {
  name: "my-widget",
  type: "tool",
  description: "A widget",
  userId: "user-1",
};

describe("extension-author.workflow.yaml — shape", () => {
  test("loads and passes definition-time validation", () => {
    expect(chain.name).toBe("extension-author");
    expect(chain.steps.map((s) => s.name)).toEqual([
      "scaffold",
      "scaffolded",
      "validate",
      "verified",
      "handoff",
      "request-install",
    ]);
  });

  test("parks on the extension's GATED install tool, not a raw host function", () => {
    // `installAuthoredDraft` is an exported function with no consent logic —
    // reaching it from a step would be the hand-rolled bypass drafts-handler
    // warns about. The chain must go through the tool the PDP gates.
    const last = chain.steps[chain.steps.length - 1];
    expect(last?.kind).toBe("tool");
    expect(last?.tool).toBe("extension-author__install_draft");
  });

  test("both gates are real gate steps with conditions", () => {
    for (const name of ["scaffolded", "verified"]) {
      const step = chain.steps.find((s) => s.name === name);
      expect(step?.kind).toBe("gate");
      expect(step?.condition).toBeDefined();
    }
  });
});

describe("extension-author chain — the happy path parks", () => {
  test("terminalizes awaiting_approval, never success", async () => {
    const { wf } = executorWith();

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.status).toBe("awaiting_approval");
    expect(run.status).not.toBe("success");
    expect(run.result?.success).toBe(false);
    expect(run.result?.error).toEqual({
      code: "awaiting_approval",
      message:
        'Step "request-install" requires interactive approval for capability fs.write and cannot run in a workflow',
    });
  });

  test("the parked run carries the {draftId, userId, verifyResult} handoff", async () => {
    const { wf } = executorWith();

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.result?.output).toMatchObject({
      draftId: "draft-abc",
      userId: "user-1",
      verifyResult: { ok: true, pass: true },
      openUrl: "/extensions/author?prefill=draft-abc",
    });
    // The `nextStep` line is interpolated (`{{ … }}` templates), so it names
    // the ACTUAL draft and the owner-scoped endpoint a human must use.
    const nextStep = String((run.result?.output as { nextStep: string }).nextStep);
    expect(nextStep).toContain("Draft draft-abc");
    expect(nextStep).toContain("POST /api/extensions/author/install");
    expect(nextStep).toContain("/extensions/author?prefill=draft-abc");
  });

  test("every automatable step ran and only the install step is parked", async () => {
    const { wf } = executorWith();

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.steps.map((s) => [s.stepName, s.status])).toEqual([
      ["scaffold", "success"],
      ["scaffolded", "success"],
      ["validate", "success"],
      ["verified", "success"],
      ["handoff", "success"],
      ["request-install", "awaiting_approval"],
    ]);
  });

  test("threads the scaffolded draftId into validate AND install", async () => {
    const { wf, calls } = executorWith();

    await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(calls.map((c) => c.tool)).toEqual([
      "extension-author__create_extension",
      "extension-author__validate_extension",
      "extension-author__install_draft",
    ]);
    expect(calls[0]?.input).toEqual({
      name: "my-widget",
      type: "tool",
      description: "A widget",
    });
    // The whole reason tool-step output is JSON-projected: without it there
    // is no way to get `draft-abc` out of step 1 and into steps 3 and 6.
    expect(calls[1]?.input).toEqual({ draftId: "draft-abc" });
    expect(calls[2]?.input).toEqual({ draftId: "draft-abc" });
  });
});

describe("extension-author chain — the gates assert real things", () => {
  test("a scaffold with no draftId fails the `scaffolded` gate, naming the ref", async () => {
    const { wf, calls } = executorWith({ scaffold: { openUrl: "/x" } });

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain('Gate "scaffolded" failed');
    expect(String(run.result?.error)).toContain("$steps.scaffold.output.draftId");
    // It stopped BEFORE validate — no wasted verify, no install attempt.
    expect(calls.map((c) => c.tool)).toEqual(["extension-author__create_extension"]);
  });

  test("an empty-string draftId fails the `scaffolded` gate's truthy leaf", async () => {
    const { wf } = executorWith({ scaffold: { draftId: "", openUrl: "/x" } });

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain('Gate "scaffolded" failed');
  });

  test("pass:false fails the `verified` gate and never reaches install", async () => {
    const { wf, calls } = executorWith({
      verify: {
        ok: false,
        pass: false,
        steps: [{ name: "smokeTest", ok: false, detail: "tool returned isError" }],
      },
    });

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain('Gate "verified" failed');
    expect(String(run.result?.error)).toContain("$steps.validate.output.pass");
    expect(calls.map((c) => c.tool)).not.toContain("extension-author__install_draft");
  });

  test("a MISSING `pass` fails closed (eq true, not truthy)", async () => {
    // `ok: true` alone must not be enough — a verify response that lost its
    // `pass` field would otherwise install an unverified draft.
    const { wf } = executorWith({ verify: { ok: true, steps: [] } });

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain('Gate "verified" failed');
  });

  test("a truthy-but-not-true `pass` fails closed too", async () => {
    const { wf } = executorWith({ verify: { ok: true, pass: "yes", steps: [] } });

    const run = await wf.runWorkflow(chain, INPUT, undefined, "user-1");

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain('Gate "verified" failed');
  });
});

describe("parseToolOutput — why tool steps can chain at all", () => {
  test("parses a JSON object so later steps can address it by path", () => {
    expect(parseToolOutput('{"draftId":"d1","pass":true}')).toEqual({
      draftId: "d1",
      pass: true,
    });
  });

  test("parses a JSON array", () => {
    expect(parseToolOutput("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseToolOutput('\n  {"a":1}\n')).toEqual({ a: 1 });
  });

  test("leaves plain prose EXACTLY as-is (no pre-existing tool step changes)", () => {
    expect(parseToolOutput("hello from the tool")).toBe("hello from the tool");
    expect(parseToolOutput("line-1\nline-2")).toBe("line-1\nline-2");
    expect(parseToolOutput("")).toBe("");
  });

  test("does NOT parse bare scalars — that would change the value's TYPE", () => {
    // `42` → number and `"x"` → unquoted string would silently break an
    // existing `eq` / `contains` condition written against the raw text.
    expect(parseToolOutput("42")).toBe("42");
    expect(parseToolOutput("true")).toBe("true");
    expect(parseToolOutput("null")).toBe("null");
    expect(parseToolOutput('"quoted"')).toBe('"quoted"');
  });

  test("text that only LOOKS like JSON stays a string, never a silent {}", () => {
    expect(parseToolOutput('{"truncated": ')).toBe('{"truncated": ');
    expect(parseToolOutput("{ not json at all")).toBe("{ not json at all");
    expect(parseToolOutput("[oops")).toBe("[oops");
  });
});
