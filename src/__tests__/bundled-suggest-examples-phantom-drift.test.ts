import { describe, expect, test } from "bun:test";
import { canonicalizeAndHash, canonicalizeAndHashForReapproval } from "../extensions/bundled-lock";
import type { ToolDefinition } from "../extensions/types";

describe("canonicalizeAndHashForReapproval", () => {
  const base: ToolDefinition = {
    name: "search-web",
    description: "Search the web for a query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  } as ToolDefinition;

  test("ignores suggestExamples — authoring one is not a capability change", () => {
    const withExamples = { ...base, suggestExamples: ["search the web for bun"] };
    expect(canonicalizeAndHashForReapproval([withExamples as ToolDefinition]))
      .toBe(canonicalizeAndHashForReapproval([base]));
  });

  test("the LOCKFILE hash still notices suggestExamples (tamper fidelity)", () => {
    const withExamples = { ...base, suggestExamples: ["search the web for bun"] };
    expect(canonicalizeAndHash([withExamples as ToolDefinition]))
      .not.toBe(canonicalizeAndHash([base]));
  });

  test.each([
    ["description", { ...base, description: "Something else entirely." }],
    ["name", { ...base, name: "search-web-v2" }],
    ["inputSchema", { ...base, inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    ["capabilities", { ...base, capabilities: { network: { hosts: ["evil.example"] } } }],
  ])("still flips on a real %s change", (_field, mutated) => {
    expect(canonicalizeAndHashForReapproval([mutated as ToolDefinition]))
      .not.toBe(canonicalizeAndHashForReapproval([base]));
  });

  test("still flips when a tool is added or removed", () => {
    const second = { ...base, name: "read-url" } as ToolDefinition;
    expect(canonicalizeAndHashForReapproval([base, second]))
      .not.toBe(canonicalizeAndHashForReapproval([base]));
  });

test("reapproval hashing ignores the known presentation card type", () => {
  const card = { ...base, cardType: "search-results" } as ToolDefinition;
  expect(canonicalizeAndHashForReapproval([card])).toBe(canonicalizeAndHashForReapproval([base]));
  expect(canonicalizeAndHash([card])).not.toBe(canonicalizeAndHash([base]));
});

test("reapproval hashing canonicalizes tool ordering", () => {
  const second = { ...base, name: "read-url" } as ToolDefinition;
  expect(canonicalizeAndHashForReapproval([base, second])).toBe(canonicalizeAndHashForReapproval([second, base]));
  expect(canonicalizeAndHash([base, second])).toBe(canonicalizeAndHash([second, base]));
});

test("reapproval hashing canonicalizes schema object keys", () => {
  const reordered = { ...base, inputSchema: { properties: { query: { type: "string" } }, type: "object" } } as ToolDefinition;
  expect(canonicalizeAndHashForReapproval([reordered])).toBe(canonicalizeAndHashForReapproval([base]));
  expect(canonicalizeAndHash([reordered])).toBe(canonicalizeAndHash([base]));
});

test("reapproval hashing treats an empty examples list as presentation only", () => {
  const examples = { ...base, suggestExamples: [] } as ToolDefinition;
  expect(canonicalizeAndHashForReapproval([examples])).toBe(canonicalizeAndHashForReapproval([base]));
  expect(canonicalizeAndHash([examples])).not.toBe(canonicalizeAndHash([base]));
});
});
