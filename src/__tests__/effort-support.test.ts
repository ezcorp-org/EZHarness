/**
 * `src/runtime/routing/effort-support.ts` — the one definition of "will this
 * model actually apply a reasoning effort?", plus the sentence said when it
 * will not.
 *
 * The load-bearing property is the FAIL-CLOSED one: anything short of a
 * literal `reasoning: true` reads as "no". This module exists to feed
 * warnings, and a warning is only worth shipping if everything in it is
 * true — so "we cannot tell" must never be reported as "it works".
 */
import { test, expect, describe } from "bun:test";
import {
  effortIgnoredNotice,
  modelHonoursEffort,
} from "../runtime/routing/effort-support";

describe("modelHonoursEffort", () => {
  test("a model flagged reasoning:true honours the effort", () => {
    expect(modelHonoursEffort({ reasoning: true })).toBe(true);
  });

  test("the synthesized custom/local model shape (reasoning:false) does not", () => {
    // `resolveModelObject` hardcodes `reasoning: false` on BOTH synthesis
    // branches, which is exactly how an Ollama / llama.cpp / vLLM / LM Studio
    // model — or any id typed into the custom-model form — arrives.
    expect(modelHonoursEffort({ reasoning: false })).toBe(false);
  });

  test.each([
    ["an absent flag", {}],
    ["an explicitly undefined flag", { reasoning: undefined }],
    ["a null model", null],
    ["an undefined model", undefined],
  ])("%s reads as 'does not honour', never as 'does'", (_label, model) => {
    expect(modelHonoursEffort(model as never)).toBe(false);
  });

  test("a TRUTHY non-true flag is still not a yes", () => {
    // A hand-edited settings row can hold `reasoning: "yes"`. Treating that
    // as capable would suppress a warning that is in fact warranted.
    expect(modelHonoursEffort({ reasoning: 1 as unknown as boolean })).toBe(false);
    expect(modelHonoursEffort({ reasoning: "true" as unknown as boolean })).toBe(false);
  });
});

describe("effortIgnoredNotice", () => {
  test("names the effort, the provider and the model that dropped it", () => {
    const text = effortIgnoredNotice({
      provider: "ollama",
      model: "qwen3:1.7b",
      effort: "high",
    });
    expect(text).toContain('"high"');
    expect(text).toContain("ollama/qwen3:1.7b");
  });

  test("says the effort was IGNORED, not that it was lowered", () => {
    // pi-ai clamps the level to "off" and then drops the field entirely, so
    // no reasoning setting reaches the wire at all. "Reduced to minimal"
    // would be a comforting lie about a request that simply vanished.
    const text = effortIgnoredNotice({ provider: "p", model: "m", effort: "max" });
    expect(text).toContain("was ignored");
    expect(text).not.toContain("reduced");
  });

  test("explains WHY, in the same terms the consent dialog already uses", () => {
    // `web/src/lib/workflow-delegations-logic.ts#tokenBoundExclusions` warns
    // about the same fact before a delegation is granted. A person who read
    // it there must recognise it in the run log.
    const text = effortIgnoredNotice({ provider: "p", model: "m", effort: "low" });
    expect(text).toContain("does not accept a reasoning setting");
    expect(text).toContain("Local and custom models never do");
  });
});
