import { describe, expect, test } from "bun:test";
import { bareWorkflowName, isForkNameRequestable, pickForkName } from "../runtime/workflow-fork";
import { isValidWorkflowName } from "../runtime/workflow-name";

const free = () => false;

describe("bareWorkflowName", () => {
  test("strips the extension namespace", () => {
    expect(bareWorkflowName("ez-factory:docs-factory")).toBe("docs-factory");
  });

  test("leaves a bare host name alone", () => {
    expect(bareWorkflowName("deploy")).toBe("deploy");
  });

  test("splits on the FIRST separator — an extension name can never contain one", () => {
    expect(bareWorkflowName("ext:a:b")).toBe("a:b");
  });
});

describe("pickForkName", () => {
  test("a fork takes the bare half, because ':' is illegal in a declared name", () => {
    // `WORKFLOW_NAME_RE` excludes the separator and the extension loader
    // rejects a declared name containing it — which is exactly what makes
    // namespacing structural. So a fork CANNOT keep its source name.
    const name = pickForkName("ez-factory:docs-factory", free);
    expect(name).toBe("docs-factory");
    expect(isValidWorkflowName(name)).toBe(true);
  });

  test("suffixes -2 on collision with the global unique index", () => {
    expect(pickForkName("ez-factory:docs-factory", (n) => n === "docs-factory")).toBe(
      "docs-factory-2",
    );
  });

  test("walks the suffix until it finds a free name", () => {
    const taken = new Set(["docs", "docs-2", "docs-3"]);
    expect(pickForkName("docs", (n) => taken.has(n))).toBe("docs-4");
  });

  test("a fork of a fork is an ordinary clone through the same rule", () => {
    // No chain walking, no special case — each fork is an independent row.
    expect(pickForkName("docs-factory-2", (n) => n === "docs-factory-2")).toBe("docs-factory-2-2");
  });

  test("truncates before suffixing, so a maximal name still forks legally", () => {
    const long = "a".repeat(64);
    expect(isValidWorkflowName(long)).toBe(true);
    const forked = pickForkName(long, (n) => n === long.slice(0, 60));
    expect(isValidWorkflowName(forked)).toBe(true);
    expect(forked).toBe(`${"a".repeat(60)}-2`);
  });

  test("gives up loudly rather than looping forever", () => {
    expect(() => pickForkName("docs", () => true)).toThrow(/Could not find a free name/);
  });

  test("every produced name satisfies the shared workflow-name grammar", () => {
    const taken = new Set(["docs-factory"]);
    for (let i = 0; i < 20; i++) {
      const name = pickForkName("ez-factory:docs-factory", (n) => taken.has(n));
      expect(isValidWorkflowName(name)).toBe(true);
      taken.add(name);
    }
  });

  test("an AUTHOR-supplied name is honoured verbatim when it is free", () => {
    // The single copy verb lets the user name the copy before it exists,
    // so the route hands `pickForkName` a name it did not derive.
    expect(pickForkName("docs-factory-copy", free)).toBe("docs-factory-copy");
  });
});

describe("isForkNameRequestable", () => {
  test("accepts a name the grammar accepts", () => {
    expect(isForkNameRequestable("docs-factory-copy")).toBe(true);
  });

  test("accepts a namespaced request — only the bare half is ever used", () => {
    expect(isForkNameRequestable("ez-factory:docs-factory")).toBe(true);
  });

  test("accepts an over-long name, because pickForkName truncates it", () => {
    // The two must agree: rejecting here what `pickForkName` would happily
    // truncate would 400 a request the naming rule can satisfy.
    const long = "a".repeat(200);
    expect(isForkNameRequestable(long)).toBe(true);
    expect(isValidWorkflowName(pickForkName(long, free))).toBe(true);
  });

  test("rejects a name no suffix could ever rescue", () => {
    // Precisely the case that used to reach a 409: `pickForkName` bares,
    // truncates, then consults the grammar — so a bad charset is rejected
    // 1000 times over and reported as "could not find a free name".
    expect(isForkNameRequestable("Bad Name!")).toBe(false);
    expect(() => pickForkName("Bad Name!", free)).toThrow(/Could not find a free name/);
  });

  test("rejects a request whose bare half is empty", () => {
    expect(isForkNameRequestable("ez-factory:")).toBe(false);
  });
});
