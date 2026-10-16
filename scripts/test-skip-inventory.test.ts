import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withoutGitContext } from "@ezcorp/sdk/git";
import {
  assignsVariable,
  FIXTURE_TREE,
  fixtureAddressLines,
  fixtureAddressViolations,
  inventoryViolations,
  readSkipInventory,
  readSkipRegistry,
  type SkipRegistryRow,
  repositoryReader,
  repositoryTestFiles,
  testGates,
  type SkipInventoryRow,
} from "./test-skip-inventory.ts";

const ROOT = resolve(import.meta.dir, "..");
const temporary: string[] = [];
afterAll(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixtureRepository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "w4h33-skip-inventory-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Violations for in-memory test files and other repository files. */
function judge(tests: Record<string, string>, rows: SkipInventoryRow[], others: Record<string, string> = {}): string[] {
  const all: Record<string, string> = { ...others, ...tests };
  return inventoryViolations(new Map(Object.entries(tests)), rows, (path) => all[path]);
}

describe("testGates finds what never runs and what is gated", () => {
  test("a static describe.skip, test.todo or a Playwright test.skip(name, fn) never runs", () => {
    const gates = testGates([
      'describe.skip("retired", () => { test("a", () => {}); });',
      'test.todo("later");',
      'test.skip("by hand", async () => {});',
    ].join("\n"));
    expect(gates.staticSkips).toHaveLength(3);
    expect(gates.conditionalGates).toEqual([]);
  });

  test("a skip in a comment or a string is not a gate", () => {
    const gates = testGates([
      "// describe.skip(\"old\") was removed",
      'const text = "test.skipIf(process.env.X)";',
      "test(\"runs\", () => { expect(text).toContain(\"skipIf\"); });",
    ].join("\n"));
    expect(gates).toEqual({ staticSkips: [], conditionalGates: [], gateVariables: [] });
  });

  test("a conditional alias is a gate, not a static skip, and its variable is found through a const", () => {
    const gates = testGates([
      'const NETWORK = process.env.NET_GATE === "1";',
      "const describeNetwork = NETWORK ? describe : describe.skip;",
      'describeNetwork("live", () => {});',
    ].join("\n"));
    expect(gates.staticSkips).toEqual([]);
    expect(gates.conditionalGates).toEqual(["? describe : describe.skip NETWORK"]);
    expect(gates.gateVariables).toEqual(["NET_GATE"]);
  });

  test("the reversed alias (cond ? describe.skip : describe) is a gate too", () => {
    const gates = testGates("const d = process.env.OFF ? describe.skip : describe;\nd(\"x\", () => {});");
    expect(gates.staticSkips).toEqual([]);
    expect(gates.gateVariables).toEqual(["OFF"]);
  });

  test("skipIf, if, runIf and todoIf read variables directly, by index, and through Bun.env", () => {
    const gates = testGates([
      'test.skipIf(process.env.A !== "1")("a", () => {});',
      'describe.if(process.env["B"] === "1")("b", () => {});',
      "test.runIf(Bun.env.C)(\"c\", () => {});",
      "test.todoIf(!probe(1, 2))(\"d\", () => {});",
    ].join("\n"));
    expect(gates.conditionalGates).toHaveLength(4);
    expect(gates.gateVariables).toEqual(["A", "B", "C"]);
  });

  test("a gate on an imported const reads the variable the imported module names", () => {
    const helper = "export const BASE = process.env.HELPER_URL;\nexport const KEY = process.env.HELPER_KEY;";
    const gates = testGates(
      'import { BASE, KEY as Key } from "./_guard";\ndescribe.skipIf(!(BASE && Key))("e2e", () => {});',
      (specifier) => (specifier === "./_guard" ? helper : undefined),
    );
    expect(gates.gateVariables).toEqual(["HELPER_KEY", "HELPER_URL"]);
  });

  test("a gate on a host probe reads no variable, and a nested call keeps its whole condition", () => {
    const gates = testGates([
      'const HAS = Bun.which("rg") !== null;',
      'test.skipIf(!HAS)("rg", () => {});',
      'test.skip(({ isMobile }) => isMobile, "desktop only");',
      "describe.if(f([1, { a: 2 }]))(\"nested\", () => {});",
      "test.skipIf(unclosed(",
    ].join("\n"));
    expect(gates.gateVariables).toEqual([]);
    expect(gates.conditionalGates).toContain("describe.if( f([1, { a: 2 }])");
    expect(gates.conditionalGates).toContain("test.skip( ({ isMobile }) => isMobile");
  });

  test("an unresolvable import and a deep const chain stop without a variable", () => {
    const gates = testGates([
      'import { FAR } from "./absent";',
      "const A = B; const B = C; const C = process.env.DEEP;",
      "describe.skipIf(!FAR && !A)(\"x\", () => {});",
    ].join("\n"));
    expect(gates.gateVariables).toEqual([]);
  });
});

describe("assignsVariable", () => {
  test("shell, YAML, object-key and quoted-key assignments count; a read does not", () => {
    expect(assignsVariable("DOCKER_TEST=1 bun x", "DOCKER_TEST")).toBe(true);
    expect(assignsVariable("        env:\n          RUN_IT: \"1\"\n", "RUN_IT")).toBe(true);
    expect(assignsVariable("{ EZ_URL: baseURL, EZ_KEY: key }", "EZ_KEY")).toBe(true);
    expect(assignsVariable('env "PROOF=1" bash -c x', "PROOF")).toBe(true);
    expect(assignsVariable('{ "QUOTED": "1" }', "QUOTED")).toBe(true);
    expect(assignsVariable('if [ "$RUN_IT" = 1 ]; then echo "$RUN_IT"; fi', "RUN_IT")).toBe(false);
    expect(assignsVariable("process.env.RUN_IT === \"1\"", "RUN_IT")).toBe(false);
  });
});

describe("inventoryViolations", () => {
  const envGated = 'test.skipIf(process.env.LANE_FLAG !== "1")("x", () => {});';
  const envRow = (over: Partial<SkipInventoryRow> = {}): SkipInventoryRow => ({
    file: "a.test.ts", kind: "env", variables: ["LANE_FLAG"], setters: ["lane.yml"], reason: "lane test", ...over,
  });

  test("a static skip with no tracked row is a test that never runs", () => {
    expect(judge({ "a.test.ts": 'describe.skip("old", () => {});' }, [])).toEqual([
      'a.test.ts: a test that never runs (describe.skip("old", () => {});); make it run, delete it, or add a tracked row with an issue',
    ]);
  });

  test("a conditional gate with no row is refused by name", () => {
    expect(judge({ "a.test.ts": envGated }, [])[0]).toStartWith("a.test.ts: a gated test with no inventory row (test.skipIf(");
  });

  test("an env row passes only when every setter assigns every variable the gate reads", () => {
    expect(judge({ "a.test.ts": envGated }, [envRow()], { "lane.yml": "env:\n  LANE_FLAG: \"1\"\n" })).toEqual([]);
    expect(judge({ "a.test.ts": envGated }, [envRow()], { "lane.yml": "run: echo $LANE_FLAG\n" })).toEqual([
      "a.test.ts: no lane sets LANE_FLAG (setter lane.yml does not assign it)",
    ]);
    expect(judge({ "a.test.ts": envGated }, [envRow({ setters: ["gone.yml"] })])).toEqual(["a.test.ts: setter gone.yml does not exist"]);
    expect(judge({ "a.test.ts": envGated }, [envRow({ setters: [] })])).toEqual(["a.test.ts: an env row needs its variables and at least one setter"]);
    expect(judge({ "a.test.ts": envGated }, [envRow({ variables: ["OTHER"] })], { "lane.yml": "OTHER=1" })).toEqual([
      "a.test.ts: the gate reads LANE_FLAG, which its row does not name",
    ]);
  });

  test("a gate through a relative import is judged by the imported module", () => {
    const guard = "export const URL_SET = process.env.GUARD_URL;";
    const tests = { "pkg/e2e/a.test.ts": 'import { URL_SET } from "./_guard";\ndescribe.skipIf(!URL_SET)("e2e", () => {});' };
    const row = envRow({ file: "pkg/e2e/a.test.ts", variables: ["GUARD_URL"], setters: ["spec.ts"] });
    expect(judge(tests, [row], { "pkg/e2e/_guard.ts": guard, "spec.ts": "{ GUARD_URL: baseURL }" })).toEqual([]);
    expect(judge(tests, [row], { "pkg/e2e/_guard/index.ts": guard, "spec.ts": "{ GUARD_URL: baseURL }" })).toEqual([]);
    const bare = { "pkg/e2e/a.test.ts": 'import { URL_SET } from "lib";\ndescribe.skipIf(!URL_SET)("e2e", () => {});' };
    expect(judge(bare, [{ file: "pkg/e2e/a.test.ts", kind: "capability", reason: "probe" }])).toEqual([]);
    const missing = { "pkg/e2e/a.test.ts": 'import { URL_SET } from "./absent";\ndescribe.skipIf(!URL_SET)("e2e", () => {});' };
    expect(judge(missing, [{ file: "pkg/e2e/a.test.ts", kind: "capability", reason: "probe" }])).toEqual([]);
  });

  test("a capability row may not hide an environment gate", () => {
    expect(judge({ "a.test.ts": envGated }, [{ file: "a.test.ts", kind: "capability", reason: "probe" }])).toEqual([
      "a.test.ts: the gate reads LANE_FLAG; an environment gate needs an env row naming the lane that sets it",
    ]);
    expect(judge({ "a.test.ts": 'test.if(probe())("x", () => {});' }, [{ file: "a.test.ts", kind: "capability", reason: "probe" }])).toEqual([]);
  });

  test("a tracked row keeps a static skip only with an issue that the test file names", () => {
    const skipped = '// tracked: #412\ndescribe.skip("waits on #412", () => {});';
    expect(judge({ "a.test.ts": skipped }, [{ file: "a.test.ts", kind: "tracked", issue: "#412", reason: "upstream" }])).toEqual([]);
    expect(judge({ "a.test.ts": skipped }, [{ file: "a.test.ts", kind: "tracked", issue: "#413", reason: "upstream" }])).toEqual([
      "a.test.ts: the tracked issue #413 is not named in the test file",
    ]);
    expect(judge({ "a.test.ts": skipped }, [{ file: "a.test.ts", kind: "tracked", reason: "upstream" }])).toEqual([
      "a.test.ts: a tracked row needs an issue reference (#123 or a GitHub issue URL)",
    ]);
  });

  describe("a precondition skip (team-lead's ruling for a lane that lacks a suite's preconditions)", () => {
    const REGISTRY: SkipRegistryRow[] = [{
      id: "ai-kit-deployed-lane",
      suites: ["a.test.ts"],
      preconditions: ["ai-kit installed", "MODEL_PIN"],
      reason: "the deployed-service lane is not seeded yet",
      ledger: "leftovers-2026-10-16 ai-kit-deployed-lane",
      owner: "w4h-36",
    }];
    const REASON = "skip: precondition ai-kit installed missing; tracked: ai-kit-deployed-lane";
    const probe = (reason: string) => `const NEEDS = "${reason}";\ndescribe.skipIf(skipUnless(present, NEEDS))("x", () => {});`;
    const row = (file = "a.test.ts"): SkipInventoryRow => ({ file, kind: "capability", reason: "deployed-service preconditions" });
    const judgeSkip = (file: string, source: string, registry = REGISTRY) => inventoryViolations(new Map([[file, source]]), [row(file)], () => undefined, registry);

    test("passes only in the exact form, with a registry id whose suites list the file and whose names list the precondition", () => {
      expect(judgeSkip("a.test.ts", probe(REASON))).toEqual([]);
      // A file without a gate is not judged: a spec may assert the string a suite prints.
      const asserted = `expect(output).toContain("${REASON.replace("tracked: ai-kit-deployed-lane", "tracked: nowhere")}");`;
      expect(inventoryViolations(new Map([["a.test.ts", probe(REASON)], ["spec.ts", asserted]]), [row()], () => undefined, REGISTRY)).toEqual([]);
    });

    test("a malformed string, an unknown id, a suite the row does not list, or an unlisted precondition is refused", () => {
      expect(judgeSkip("a.test.ts", probe("skip: precondition ai-kit installed missing"))).toEqual([
        'a.test.ts: a precondition skip not in the form "skip: precondition <name> missing; tracked: <registry id>"',
      ]);
      expect(judgeSkip("a.test.ts", probe(REASON.replace("ai-kit-deployed-lane", "nowhere")))).toEqual([
        "a.test.ts: the precondition skip names nowhere, which is not a row of scripts/test-skip-registry.json",
      ]);
      expect(inventoryViolations(new Map([["a.test.ts", "test('plain', () => {});"], ["b.test.ts", probe(REASON)]]), [row("b.test.ts")], () => undefined, REGISTRY)).toEqual([
        "b.test.ts: registry row ai-kit-deployed-lane does not list this suite",
      ]);
      expect(judgeSkip("a.test.ts", probe(REASON.replace("ai-kit installed", "a database")))).toEqual([
        "a.test.ts: registry row ai-kit-deployed-lane does not list precondition a database",
      ]);
    });

    test("a registry row is complete and names suites that exist", () => {
      const broken: SkipRegistryRow = { ...REGISTRY[0]!, suites: ["gone.test.ts"], owner: " " };
      expect(inventoryViolations(new Map([["a.test.ts", "test('plain', () => {});"]]), [], () => undefined, [broken])).toEqual([
        "scripts/test-skip-registry.json: row ai-kit-deployed-lane is incomplete (id, suites, preconditions, reason, ledger, owner)",
        "scripts/test-skip-registry.json: row ai-kit-deployed-lane lists gone.test.ts, which does not exist",
      ]);
    });

    test("an env variable no lane sets passes only as a named precondition with a tracked skip in the file", () => {
      const source = `const PIN = process.env.MODEL_PIN;\nconst NEEDS = "skip: precondition MODEL_PIN missing; tracked: ai-kit-deployed-lane";\ntest.skipIf(skipUnless(!!PIN, NEEDS))("x", () => {});`;
      const envRow: SkipInventoryRow = { file: "a.test.ts", kind: "env", variables: ["MODEL_PIN"], setters: [], preconditions: { MODEL_PIN: "ai-kit-deployed-lane" }, reason: "pin" };
      expect(inventoryViolations(new Map([["a.test.ts", source]]), [envRow], () => undefined, REGISTRY)).toEqual([]);
      expect(inventoryViolations(new Map([["a.test.ts", source.replace(/const NEEDS.*\n/, "")]]), [envRow], () => undefined, REGISTRY)).toEqual([
        "a.test.ts: precondition MODEL_PIN has no tracked skip for ai-kit-deployed-lane in the file",
      ]);
    });
  });

  test("duplicate, missing, reasonless and stale rows are refused", () => {
    const capability: SkipInventoryRow = { file: "a.test.ts", kind: "capability", reason: "probe" };
    expect(judge({ "a.test.ts": 'test("plain", () => {});' }, [capability, { ...capability, reason: " " }, { ...capability, file: "gone.test.ts" }])).toEqual([
      "a.test.ts: more than one inventory row",
      "a.test.ts: inventory row has no reason",
      "gone.test.ts: inventory row for a test file that does not exist",
      "a.test.ts: stale inventory row; the file has no gate",
    ]);
  });
});

describe("fixture addresses (identity-check.sh files mode in the repository)", () => {
  // Every address below is built at run time, so this file itself holds none on a real domain.
  const AT = "@";
  const realDomain = `jane.roe${AT}personal-mail.net`;

  test("reserved domains, the archy noreply address, URL userinfo, scp remotes and unit names pass", () => {
    const source = [
      `w4h28-proof${AT}example.invalid a${AT}example.com b${AT}x.example.org c${AT}host.test d${AT}h.invalid`,
      `e${AT}localhost.localhost f${AT}EXAMPLE.NET g${AT}y.example h${AT}box.local`,
      `Co-authored-by: archy <281643943+EZArchy${AT}users.noreply.github.com>`,
      `remote git${AT}github.com:org/repo.git and https://user${AT}host.org.net/x`,
      `systemctl restart user${AT}1001.service; a version 1${AT}2.0.patch`,
    ].join("\n");
    expect(fixtureAddressLines(source)).toEqual([]);
  });

  test("an address on a real domain is refused by line, another GitHub noreply too, and the message never repeats it", () => {
    const source = ["const ok = 1;", `email: "${realDomain}"`, "", `bot: "12345+someone${AT}users.noreply.github.com"`].join("\n");
    expect(fixtureAddressLines(source)).toEqual([2, 4]);
    const violations = fixtureAddressViolations(new Map([["a.test.ts", source]]));
    expect(violations).toEqual([
      "a.test.ts:2: a fixture address on a non-reserved domain; use example.com, *.example, *.invalid, *.test, *.localhost or *.local",
      "a.test.ts:4: a fixture address on a non-reserved domain; use example.com, *.example, *.invalid, *.test, *.localhost or *.local",
    ]);
    expect(violations.join("\n")).not.toContain("personal-mail");
  });
});

describe("the repository", () => {
  test("lists tracked test files only: no vendored node_modules, no deleted file", () => {
    const root = fixtureRepository({ "a.test.ts": "x", "node_modules/b.test.ts": "x", "c.spec.ts": "x", "d.ts": "x", "tests/fixture.ts": "y" });
    const env = { ...withoutGitContext(process.env), GIT_CONFIG_NOSYSTEM: "1" };
    for (const argv of [["git", "init", "-q"], ["git", "add", "-f", "."]]) expect(Bun.spawnSync(argv, { cwd: root, env }).exitCode).toBe(0);
    rmSync(join(root, "c.spec.ts"));
    expect([...repositoryTestFiles(root).keys()]).toEqual(["a.test.ts"]);
    expect(repositoryReader(root)("node_modules")).toBeUndefined();
    expect(repositoryReader(root)("a.test.ts")).toBe("x");
    // The fixture tree adds the fixture folders, and leaves a binary file out.
    writeFileSync(join(root, "tests", "bin.dat"), "a\0b");
    expect(Bun.spawnSync(["git", "add", "-f", "tests"], { cwd: root, env }).exitCode).toBe(0);
    expect([...repositoryTestFiles(root, FIXTURE_TREE).keys()].sort()).toEqual(["a.test.ts", "tests/fixture.ts"]);
    expect(() => repositoryTestFiles(fixtureRepository({ "e.test.ts": "x" }))).toThrow("git ls-files failed");
  });

  test("every gated test file names the lane that sets its variable or the capability it probes, and nothing never runs", () => {
    const violations = inventoryViolations(repositoryTestFiles(ROOT), readSkipInventory(ROOT), repositoryReader(ROOT), readSkipRegistry(ROOT));
    expect(violations).toEqual([]);
  });

  test("every fixture address in the test tree is on a reserved domain", () => {
    expect(fixtureAddressViolations(repositoryTestFiles(ROOT, FIXTURE_TREE))).toEqual([]);
  });
});
