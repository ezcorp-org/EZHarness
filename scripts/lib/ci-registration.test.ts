import { describe, expect, test } from "bun:test";
import { missingProducers, missingThresholds, workflowCommands } from "./ci-registration.ts";

describe("workflowCommands", () => {
  test("removes whole-line and trailing comments", () => {
    expect(workflowCommands("# bun test ./a.test.ts\n- run: bun test ./b.test.ts # and ./c.test.ts")).toBe(
      "\n- run: bun test ./b.test.ts",
    );
  });

  test("keeps a hash that belongs to a quoted value", () => {
    expect(workflowCommands('- run: echo "sha256:#abc"')).toBe('- run: echo "sha256:#abc"');
  });

  test("keeps a hash with no preceding whitespace, which cannot open a YAML comment", () => {
    expect(workflowCommands("- run: curl https://host/x#fragment")).toBe("- run: curl https://host/x#fragment");
  });
});

describe("missingProducers", () => {
  test("reports nothing when every producer is actually run", () => {
    expect(missingProducers("- run: bun test ./a.test.ts", [["a suite", "./a.test.ts"]])).toEqual([]);
  });

  test("reports a producer that only appears in a comment", () => {
    expect(missingProducers("# ./a.test.ts runs elsewhere", [["a suite", "./a.test.ts"]])).toEqual(["a suite"]);
  });

  test("reports every missing producer, not just the first", () => {
    expect(missingProducers("- run: true", [["one", "./a.test.ts"], ["two", "./b.test.ts"]])).toEqual(["one", "two"]);
  });
});

describe("missingThresholds", () => {
  test("accepts an exact 100 floor", () => {
    expect(missingThresholds('{"src/x.ts": 100}', ["src/x.ts"])).toEqual([]);
  });

  test("rejects a lowered floor and a missing key", () => {
    expect(missingThresholds('{"src/x.ts": 99}', ["src/x.ts"])).toEqual(["src/x.ts threshold"]);
    expect(missingThresholds("{}", ["src/y.ts"])).toEqual(["src/y.ts threshold"]);
  });
});
