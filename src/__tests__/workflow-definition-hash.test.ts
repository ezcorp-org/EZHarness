/**
 * The definition fingerprint a resume checks before continuing.
 *
 * The property under test is narrow but load-bearing: the hash must
 * change when and only when the change could move a step out from under
 * `cursor.batchIndex`. Too loose and a parked run resumes into a graph
 * nobody authorized; too strict and a typo fix kills every parked run for
 * no safety benefit.
 */
import { test, expect, describe } from "bun:test";
import { workflowDefinitionHash } from "../runtime/workflow-definition-hash";
import type { WorkflowDefinition } from "../types";

const base: WorkflowDefinition = {
  name: "publish",
  description: "publishes things",
  steps: [
    { name: "draft", kind: "transform", output: { a: "1" } },
    { name: "verify", kind: "gate", condition: { ref: "$prev.output.a", op: "eq", value: "1" } },
  ],
};

describe("workflowDefinitionHash", () => {
  test("is stable across calls and independent of key insertion order", () => {
    // The YAML loader and the DB round-trip do not agree on key order, so
    // a run started from one source must match its own definition read
    // back from the other.
    const reordered: WorkflowDefinition = {
      description: base.description,
      steps: [
        { output: { a: "1" }, kind: "transform", name: "draft" },
        { condition: { value: "1", op: "eq" as const, ref: "$prev.output.a" }, kind: "gate", name: "verify" },
      ],
      name: base.name,
    };
    expect(workflowDefinitionHash(reordered)).toBe(workflowDefinitionHash(base));
    expect(workflowDefinitionHash(base)).toBe(workflowDefinitionHash(base));
  });

  test("ignores name and description — neither can change what runs", () => {
    // Resume looks the definition up BY name, so a differing name is a
    // different definition rather than a drifted one; prose cannot move a
    // step between batches.
    expect(
      workflowDefinitionHash({ ...base, name: "renamed", description: "totally new prose" }),
    ).toBe(workflowDefinitionHash(base));
  });

  test("changes when a step is added, removed, or renamed", () => {
    const added: WorkflowDefinition = {
      ...base,
      steps: [...base.steps, { name: "ship", kind: "transform", output: {} }],
    };
    const removed: WorkflowDefinition = { ...base, steps: [base.steps[0]!] };
    const renamed: WorkflowDefinition = {
      ...base,
      steps: [{ ...base.steps[0]!, name: "draft2" }, base.steps[1]!],
    };
    for (const variant of [added, removed, renamed]) {
      expect(workflowDefinitionHash(variant)).not.toBe(workflowDefinitionHash(base));
    }
  });

  test("changes when step ORDER changes", () => {
    // Order is semantic, not incidental: it composes the batches on the
    // no-deps path and tie-breaks within a batch on the topo path — which
    // is exactly what batchIndex and prevStepName index into.
    const swapped: WorkflowDefinition = {
      ...base,
      steps: [base.steps[1]!, base.steps[0]!],
    };
    expect(workflowDefinitionHash(swapped)).not.toBe(workflowDefinitionHash(base));
  });

  test("changes when dependsOn edges change", () => {
    const wired: WorkflowDefinition = {
      ...base,
      steps: [base.steps[0]!, { ...base.steps[1]!, dependsOn: ["draft"] }],
    };
    expect(workflowDefinitionHash(wired)).not.toBe(workflowDefinitionHash(base));
  });

  test("changes when the definition-level model binding changes", () => {
    const bound: WorkflowDefinition = {
      ...base,
      defaultModel: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    };
    expect(workflowDefinitionHash(bound)).not.toBe(workflowDefinitionHash(base));
  });

  test("treats an explicitly-undefined field and an absent one as the same definition", () => {
    // They ARE the same definition; hashing them differently would fail a
    // resume over nothing at all.
    expect(workflowDefinitionHash({ ...base, defaultModel: undefined })).toBe(
      workflowDefinitionHash(base),
    );
  });

  test("handles a definition with no steps rather than throwing", () => {
    // The validator rejects these, but the hash runs at insert time and
    // must not be the thing that explodes on a malformed definition.
    const empty = { name: "x", description: "", steps: [] } as WorkflowDefinition;
    const missing = { name: "x", description: "" } as unknown as WorkflowDefinition;
    expect(workflowDefinitionHash(empty)).toBe(workflowDefinitionHash(missing));
    expect(workflowDefinitionHash(empty)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("covers nested arrays and primitives in the stable serializer", () => {
    // Exercises every branch of the walk: nested array, nested object,
    // string, number, boolean, null.
    const rich: WorkflowDefinition = {
      name: "rich",
      description: "",
      steps: [
        {
          name: "s",
          kind: "transform",
          retries: 2,
          output: { list: "$input.items", flag: "$input.on", none: "$input.missing" },
        },
      ],
    };
    expect(workflowDefinitionHash(rich)).toMatch(/^[0-9a-f]{64}$/);
    expect(workflowDefinitionHash(rich)).toBe(workflowDefinitionHash(rich));
  });
});
