// Unit tests for bounded auto-spin-up (Phase B3, TASK 2). Verifies that a team
// larger than the batch size spins up in sequential waves, that a quota-rejected
// member is retried once and then reported as [deferred: quota] distinctly from
// a real member output and a genuine [error: …], all woven into the synthesized
// orchestrator prompt.

import { test, expect, describe } from "bun:test";
import { applyAutoSpinUp, AUTO_SPINUP_BATCH } from "../runtime/stream-chat/auto-spin-up";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";

interface FakeExecuteScript {
  /** name → behavior. "output:<text>" | "quota" | "quota-then:<text>" | "error:<msg>" */
  [id: string]: string;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** Build a ctx/host pair with a spy-able invoke_agent tool driven by `script`
 *  (keyed by agentConfigId). Returns the ctx plus the recorded call log. */
function makeHarness(members: Array<{ id: string; name: string }>, script: FakeExecuteScript) {
  const calls: Array<{ id: string; nth: number }> = [];
  const perId = new Map<string, number>();
  const invokeAgentTool = {
    name: "invoke_agent",
    async execute(_callId: string, args: { agentConfigId: string }) {
      const id = args.agentConfigId;
      const n = (perId.get(id) ?? 0) + 1;
      perId.set(id, n);
      calls.push({ id, nth: n });
      const behavior = script[id] ?? "output:ok";
      if (behavior === "quota") {
        return textResult(`Agent "${id}" failed: Concurrent spawn cap reached`);
      }
      if (behavior.startsWith("quota-then:")) {
        return n === 1
          ? textResult(`Agent "${id}" failed: Spawn quota exceeded`)
          : textResult(behavior.slice("quota-then:".length));
      }
      if (behavior.startsWith("error:")) {
        throw new Error(behavior.slice("error:".length));
      }
      return textResult(behavior.slice("output:".length));
    },
  };

  const emitted: Array<{ ev: string; data: unknown }> = [];
  const run: Record<string, unknown> = {
    id: "run-1",
    _pendingAutoSpinUp: true,
    _mentionedAgents: members,
    _teamConfig: { name: "Team X", prompt: "coordinate" },
  };
  const ctx = {
    run,
    controller: { signal: new AbortController().signal },
    agentTools: [invokeAgentTool],
    system: undefined as string | undefined,
  } as unknown as StreamChatContext;
  const host = {
    bus: { emit: (ev: string, data: unknown) => emitted.push({ ev, data }) },
  } as unknown as StreamChatHost;
  return { ctx, host, calls, emitted };
}

describe("applyAutoSpinUp — bounded waves", () => {
  test("team larger than AUTO_SPINUP_BATCH spins up all members across sequential waves", async () => {
    const members = Array.from({ length: AUTO_SPINUP_BATCH + 2 }, (_, i) => ({
      id: `cfg-${i}`,
      name: `M${i}`,
    }));
    const script: FakeExecuteScript = {};
    for (const m of members) script[m.id] = `output:done-${m.id}`;
    const { ctx, host, calls } = makeHarness(members, script);

    await applyAutoSpinUp(ctx, host, "do the work");

    // Every member invoked exactly once (no quota → no retry).
    expect(calls.length).toBe(members.length);
    // The synthesized prompt carries each member's real output.
    for (const m of members) expect(ctx.system).toContain(`done-${m.id}`);
  });

  test("quota-rejected member is retried once, then reported as [deferred: quota] — distinct from output and error", async () => {
    const members = [
      { id: "cfg-out", name: "Outputter" },
      { id: "cfg-quota", name: "Quotaed" },
      { id: "cfg-err", name: "Errorer" },
    ];
    const { ctx, host, calls } = makeHarness(members, {
      "cfg-out": "output:REAL_OUTPUT_HERE",
      "cfg-quota": "quota", // stays quota even on retry → deferred
      "cfg-err": "error:kaboom",
    });

    await applyAutoSpinUp(ctx, host, "go");

    // The quota member was retried exactly once (2 calls); others called once.
    const quotaCalls = calls.filter((c) => c.id === "cfg-quota");
    expect(quotaCalls.length).toBe(2);
    expect(calls.filter((c) => c.id === "cfg-out").length).toBe(1);
    expect(calls.filter((c) => c.id === "cfg-err").length).toBe(1);

    // Three distinct states in the synthesized prompt.
    expect(ctx.system).toContain("REAL_OUTPUT_HERE");
    expect(ctx.system).toContain("[deferred: quota");
    expect(ctx.system).toContain("[error: kaboom]");
    // The deferred marker must NOT be framed as an error.
    expect(ctx.system).not.toContain("[error: Concurrent spawn cap reached]");
  });

  test("a quota rejection that clears on retry yields the real output (not deferred)", async () => {
    const members = [{ id: "cfg-recover", name: "Recoverer" }];
    const { ctx, host, calls } = makeHarness(members, {
      "cfg-recover": "quota-then:RECOVERED_OUTPUT",
    });

    await applyAutoSpinUp(ctx, host, "go");

    expect(calls.filter((c) => c.id === "cfg-recover").length).toBe(2);
    expect(ctx.system).toContain("RECOVERED_OUTPUT");
    expect(ctx.system).not.toContain("[deferred: quota");
  });
});
