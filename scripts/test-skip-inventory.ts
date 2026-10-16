#!/usr/bin/env bun
/**
 * Repository inventory of test gates (W4H-33).
 *
 * A test that never runs weakens the gates without failing them. Two shapes
 * hid on main: a `describe.skip` left in source (it can never run), and a
 * suite gated on an environment variable that no lane sets (it runs nowhere).
 * gate-integrity refuses a NEW skip in a diff; this inventory judges the whole
 * tree, so an old one is found too.
 *
 * Every gate in a test file needs a row in scripts/test-skip-inventory.json:
 *   env        the gate reads these variables, and each named setter file
 *              (a workflow, a lane script, a lane spec) assigns every one of them
 *   capability the gate reads no variable; it probes the host (a kernel
 *              feature, a binary on PATH, a locale, a browser project)
 *   tracked    a static skip, todo or only that stays, with an issue reference
 *              that the test file itself carries
 * A row for a file that no longer has a gate, or no longer exists, is stale.
 *
 * Static skips are found by gate-integrity's own scanner (forbiddenTestAdditions
 * over every line), so the two tools can never disagree about what a skip is.
 * The gate itself is scripts/test-skip-inventory.test.ts (the real tree must
 * have no violation).
 *
 * The same test holds the fixture-address rule (W4H-33, ruling 4): every
 * email-like string in the test tree is on a reserved domain (RFC 2606/6761/
 * 6762). It is identity-check.sh's `files` mode (team w00 tooling, v3) in the
 * repository, so CI can run it: the same three patterns, line by line.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withoutGitContext } from "@ezcorp/sdk/git";
import { codeMask, forbiddenTestAdditions } from "./gate-integrity.ts";

export type SkipInventoryKind = "env" | "capability" | "tracked";

export interface SkipInventoryRow {
  readonly file: string;
  readonly kind: SkipInventoryKind;
  readonly reason: string;
  /** env rows: the variables the gate reads. */
  readonly variables?: readonly string[];
  /** env rows: repository files that assign every variable (the lane that sets it). */
  readonly setters?: readonly string[];
  /** tracked rows: `#123` or a GitHub issue URL, also present in the test file. */
  readonly issue?: string;
  /**
   * env rows: variables NO lane sets yet, each a precondition tracked by a registry row (team-lead's ruling, W4H-33).
   * Such a variable needs no setter, but the file must skip with "skip: precondition <name> missing; tracked: <id>".
   */
  readonly preconditions?: Readonly<Record<string, string>>;
}

/**
 * One allowed precondition skip (scripts/test-skip-registry.json). A suite may skip with
 * "skip: precondition <name> missing; tracked: <id>" only when <id> is a row, the suite is one of its suites and <name>
 * one of its preconditions. `ledger` names the team's leftover entry that will provide the lane; the repository never
 * reads that ledger (a hosted checkout has no team evidence).
 */
export interface SkipRegistryRow {
  readonly id: string;
  readonly suites: readonly string[];
  readonly preconditions: readonly string[];
  readonly reason: string;
  readonly ledger: string;
  readonly owner: string;
}

export interface TestGates {
  /** Static skip/todo/only constructs, as gate-integrity reports them. */
  readonly staticSkips: readonly string[];
  /** Runtime-conditional gates: skipIf/if/runIf/todoIf, a `cond ? describe : describe.skip` alias, a Playwright `test.skip(cond, …)`. */
  readonly conditionalGates: readonly string[];
  /** Environment variables the conditional gates read, directly or through a const or an imported const. */
  readonly gateVariables: readonly string[];
}

const SKIP_LABEL = "added skip/only/todo";
const TERNARY_ALIAS = /\?\s*(?:describe|test|it)\s*:\s*(?:describe|test|it)\s*\.\s*(?:skip|todo)\b|\?\s*(?:describe|test|it)\s*\.\s*(?:skip|todo)\s*:\s*(?:describe|test|it)\b/;
const CALL_GATE = /\b(?:describe|test|it)\s*\.\s*(?:skipIf|if|runIf|todoIf)\s*\(/g;
const PLAYWRIGHT_CONDITIONAL = /\btest\s*\.\s*(?:skip|fixme)\s*\(\s*(?![\s),])/g;
const ENV_READ = /\b(?:process\.env|Bun\.env|import\.meta\.env)(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\])/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
/** Cheap first look: a file without any of these words has no gate, so the scanners never read it. */
const MAY_GATE = /\.\s*(?:skip|todo|only|failing|fixme|if|skipIf|runIf|todoIf)\b|\b(?:xdescribe|xit|xtest|fdescribe|fit)\b/;
const PRECONDITION_SKIP = /skip: precondition ([^;"'`\n]+) missing; tracked: ([^"'`\n]+)/g;

/** The precondition skips a source names: the well-formed ones, and how many "skip: precondition" texts are not. */
function preconditionSkips(source: string): { readonly skips: readonly { name: string; id: string }[]; readonly malformed: number } {
  const skips = [...source.matchAll(PRECONDITION_SKIP)].map((match) => ({ name: match[1]!, id: match[2]! }));
  return { skips, malformed: source.split("skip: precondition").length - 1 - skips.length };
}

const ISSUE = /^(?:#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)$/;

/** `src` with every non-code character (strings, comments, regex bodies) blanked; offsets and newlines kept. */
function codeOnly(src: string): string {
  const mask = codeMask(src);
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= src.length; i++) {
    if (i < src.length && mask[i] === mask[start]) continue;
    const run = src.slice(start, i);
    parts.push(mask[start] ? run : run.replace(/[^\n]/g, " "));
    start = i;
  }
  return parts.join("");
}

/** The text of the first argument of the call whose `(` is at `open`: up to the top-level `,` or the closing `)`. */
function firstArgument(code: string, raw: string, open: number): string {
  let depth = 0;
  for (let i = open + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return raw.slice(open + 1, i);
      depth--;
    } else if (ch === "," && depth === 0) return raw.slice(open + 1, i);
  }
  return raw.slice(open + 1);
}

/** The condition of a `NAME = cond ? describe : describe.skip` alias on the line holding `at`. */
function ternaryCondition(raw: string, at: number): string {
  const lineStart = raw.lastIndexOf("\n", at) + 1;
  const head = raw.slice(lineStart, at);
  return head.slice(head.lastIndexOf("=") + 1);
}

function constDefinition(source: string, name: string, exported: boolean): string | undefined {
  const re = new RegExp(`${exported ? "\\bexport\\s+" : "\\b"}(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\b[^=]*=\\s*([\\s\\S]*?);`, "m");
  return re.exec(source)?.[1];
}

/** The module and the exported name behind a local import binding (`import { A as B }` binds B to A). */
function importedBinding(source: string, local: string): { specifier: string; exported: string } | undefined {
  for (const m of source.matchAll(/\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of m[1]!.split(",")) {
      const [exported, alias = exported] = part.trim().split(/\s+as\s+/);
      if (alias === local) return { specifier: m[2]!, exported: exported! };
    }
  }
  return undefined;
}

/** Environment variables an expression reads: directly, or through same-file or imported consts (two levels). */
function variablesOf(expression: string, source: string, resolveImport: (specifier: string) => string | undefined, depth = 0): Set<string> {
  const found = new Set<string>();
  for (const m of expression.matchAll(ENV_READ)) found.add((m[1] ?? m[2])!);
  if (depth >= 2) return found;
  const withoutEnv = expression.replace(ENV_READ, " ");
  for (const [name] of withoutEnv.matchAll(IDENTIFIER)) {
    const local = constDefinition(source, name, false);
    if (local !== undefined) {
      for (const v of variablesOf(local, source, resolveImport, depth + 1)) found.add(v);
      continue;
    }
    const binding = importedBinding(source, name);
    const imported = binding === undefined ? undefined : resolveImport(binding.specifier);
    const definition = imported === undefined ? undefined : constDefinition(imported, binding!.exported, true);
    if (definition !== undefined) for (const v of variablesOf(definition, imported!, resolveImport, depth + 1)) found.add(v);
  }
  return found;
}

/** Every gate in one test file. `resolveImport` returns the source of a relative import, or undefined. */
export function testGates(source: string, resolveImport: (specifier: string) => string | undefined = () => undefined): TestGates {
  if (!MAY_GATE.test(source)) return { staticSkips: [], conditionalGates: [], gateVariables: [] };
  const allLines = new Set(source.split("\n").map((_, index) => index + 1));
  const skips = forbiddenTestAdditions(source, allLines).filter((finding) => finding.startsWith(SKIP_LABEL));
  const staticSkips = skips.filter((finding) => !TERNARY_ALIAS.test(finding)).map((finding) => finding.slice(SKIP_LABEL.length + 2));
  const code = codeOnly(source);
  const conditions: { construct: string; condition: string }[] = [];
  for (const re of [CALL_GATE, PLAYWRIGHT_CONDITIONAL]) {
    for (const m of code.matchAll(re)) {
      const open = m.index! + m[0].lastIndexOf("(");
      conditions.push({ construct: m[0].replace(/\s+/g, ""), condition: firstArgument(code, source, open) });
    }
  }
  const alias = new RegExp(TERNARY_ALIAS.source, "g");
  for (const m of code.matchAll(alias)) conditions.push({ construct: m[0].replace(/\s+/g, " ").trim(), condition: ternaryCondition(source, m.index!) });
  const variables = new Set<string>();
  for (const { condition } of conditions) for (const v of variablesOf(condition, source, resolveImport)) variables.add(v);
  return {
    staticSkips,
    conditionalGates: conditions.map(({ construct, condition }) => `${construct} ${condition.replace(/\s+/g, " ").trim()}`),
    gateVariables: [...variables].sort(),
  };
}

/** Whether `content` assigns `variable` (shell `V=`, YAML or object key `V:`, quoted key `"V":`). */
export function assignsVariable(content: string, variable: string): boolean {
  return new RegExp(`(?:^|[\\s"'{,(])${variable}(?:=|["']?\\s*:\\s)`, "m").test(content);
}

/**
 * Violations of the inventory rule. `files` maps every test file (repository-relative) to its source;
 * `read` returns the source of any repository file (setters, imports), or undefined when it is absent.
 */
export function inventoryViolations(
  files: ReadonlyMap<string, string>,
  rows: readonly SkipInventoryRow[],
  read: (path: string) => string | undefined,
  /** The allowed precondition skips (scripts/test-skip-registry.json). */
  registry: readonly SkipRegistryRow[] = [],
): string[] {
  const out: string[] = [];
  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  for (const entry of registry) {
    const complete = [entry.id, entry.reason, entry.ledger, entry.owner].every((field) => field.trim() !== "") && entry.suites.length > 0 && entry.preconditions.length > 0;
    if (!complete) out.push(`${SKIP_REGISTRY_PATH}: row ${entry.id} is incomplete (id, suites, preconditions, reason, ledger, owner)`);
    for (const suite of entry.suites) if (!files.has(suite)) out.push(`${SKIP_REGISTRY_PATH}: row ${entry.id} lists ${suite}, which does not exist`);
  }
  const byFile = new Map<string, SkipInventoryRow>();
  for (const row of rows) {
    if (byFile.has(row.file)) out.push(`${row.file}: more than one inventory row`);
    byFile.set(row.file, row);
    if (!files.has(row.file)) out.push(`${row.file}: inventory row for a test file that does not exist`);
    if (row.reason.trim() === "") out.push(`${row.file}: inventory row has no reason`);
  }
  for (const [file, source] of files) {
    const gates = testGates(source, (specifier) => (specifier.startsWith(".") ? resolveModule(dirname(file), specifier, read) : undefined));
    const row = byFile.get(file);
    // A skip string takes effect only through a gate; a file without one (a spec asserting the string) is not judged.
    const found = gates.conditionalGates.length > 0 ? preconditionSkips(source) : { skips: [], malformed: 0 };
    if (found.malformed > 0) out.push(`${file}: a precondition skip not in the form "skip: precondition <name> missing; tracked: <registry id>"`);
    for (const { name, id } of found.skips) {
      const entry = registryById.get(id);
      if (entry === undefined) out.push(`${file}: the precondition skip names ${id}, which is not a row of ${SKIP_REGISTRY_PATH}`);
      else if (!entry.suites.includes(file)) out.push(`${file}: registry row ${id} does not list this suite`);
      else if (!entry.preconditions.includes(name)) out.push(`${file}: registry row ${id} does not list precondition ${name}`);
    }
    if (gates.staticSkips.length > 0 && row?.kind !== "tracked") {
      for (const skip of gates.staticSkips) out.push(`${file}: a test that never runs (${skip}); make it run, delete it, or add a tracked row with an issue`);
    }
    if (gates.conditionalGates.length > 0 && row === undefined) {
      out.push(`${file}: a gated test with no inventory row (${gates.conditionalGates[0]}); name the lane that sets its variable, or the capability it probes`);
    }
    if (row === undefined) continue;
    if (gates.staticSkips.length === 0 && gates.conditionalGates.length === 0) out.push(`${file}: stale inventory row; the file has no gate`);
    if (row.kind === "tracked") {
      if (!ISSUE.test(row.issue ?? "")) out.push(`${file}: a tracked row needs an issue reference (#123 or a GitHub issue URL)`);
      else if (!source.includes(row.issue!)) out.push(`${file}: the tracked issue ${row.issue} is not named in the test file`);
    }
    if (row.kind === "capability" && gates.gateVariables.length > 0) {
      out.push(`${file}: the gate reads ${gates.gateVariables.join(", ")}; an environment gate needs an env row naming the lane that sets it`);
    }
    if (row.kind === "env") {
      const named = new Set(row.variables ?? []);
      const preconditions = row.preconditions ?? {};
      const settable = [...named].filter((variable) => !Object.hasOwn(preconditions, variable));
      for (const variable of gates.gateVariables) if (!named.has(variable)) out.push(`${file}: the gate reads ${variable}, which its row does not name`);
      if (named.size === 0 || (settable.length > 0 && (row.setters ?? []).length === 0)) out.push(`${file}: an env row needs its variables and at least one setter`);
      for (const [variable, id] of Object.entries(preconditions)) {
        if (!found.skips.some((skip) => skip.id === id)) out.push(`${file}: precondition ${variable} has no tracked skip for ${id} in the file`);
      }
      for (const setter of row.setters ?? []) {
        const content = read(setter);
        if (content === undefined) {
          out.push(`${file}: setter ${setter} does not exist`);
          continue;
        }
        for (const variable of settable) if (!assignsVariable(content, variable)) out.push(`${file}: no lane sets ${variable} (setter ${setter} does not assign it)`);
      }
    }
  }
  return out;
}

function resolveModule(directory: string, specifier: string, read: (path: string) => string | undefined): string | undefined {
  const base = join(directory, specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")]) {
    const content = read(candidate);
    if (content !== undefined) return content;
  }
  return undefined;
}

export const SKIP_INVENTORY_PATH = "scripts/test-skip-inventory.json";

/** The committed inventory rows. */
export function readSkipInventory(root: string): SkipInventoryRow[] {
  return (JSON.parse(readFileSync(join(root, SKIP_INVENTORY_PATH), "utf8")) as { rows: SkipInventoryRow[] }).rows;
}

export const SKIP_REGISTRY_PATH = "scripts/test-skip-registry.json";

/** The committed registry of allowed precondition skips. */
export function readSkipRegistry(root: string): SkipRegistryRow[] {
  return (JSON.parse(readFileSync(join(root, SKIP_REGISTRY_PATH), "utf8")) as { rows: SkipRegistryRow[] }).rows;
}

export const TEST_FILES: readonly string[] = ["*.test.ts", "*.spec.ts", "*.test.js"];
/** The test tree the fixture-address rule reads: the test files and the fixture folders around them. */
export const FIXTURE_TREE: readonly string[] = [...TEST_FILES, "web/e2e/**", "tests/**", "src/__tests__/**"];

/** Every tracked text file matching `patterns` (no vendored node_modules, no binary file). */
export function repositoryTestFiles(root: string, patterns: readonly string[] = TEST_FILES): Map<string, string> {
  // An explicit-target spawn: `root` is the repository to list, so no inherited GIT_* (a hook exports GIT_DIR and
  // GIT_INDEX_FILE) may point ls-files at another one. The shared helper strips them (git-spawn-context-guard).
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", ...patterns], { cwd: root, env: withoutGitContext(process.env) });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const files = new Map<string, string>();
  for (const path of listed.stdout.toString().split("\0")) {
    if (path === "" || path.includes("node_modules/") || !existsSync(join(root, path))) continue;
    const content = readFileSync(join(root, path), "utf8");
    if (!content.includes("\0")) files.set(path, content);
  }
  return files;
}

// identity-check.sh files mode, pattern for pattern: EMAIL, ALLOWED (case-insensitive), and the two sed masks.
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const RESERVED_ADDRESS =
  /^(?:281643943\+EZArchy@users\.noreply\.github\.com|.*@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|net|org)|example|invalid|test|localhost|local)|.*\.(?:service|socket|timer|scope|slice|mount|target|path|device|swap|patch))$/i;
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/g;
const SCP_REMOTE = /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./~-]/g;

/** 1-based lines of `source` that hold an address on a non-reserved domain (URL userinfo and scp-style remotes removed first). */
export function fixtureAddressLines(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    const masked = line.replace(URL_USERINFO, "$1").replace(SCP_REMOTE, "scp:");
    if ([...masked.matchAll(ADDRESS)].some(([address]) => !RESERVED_ADDRESS.test(address))) lines.push(index + 1);
  });
  return lines;
}

/** One violation per line; the message never repeats the address. */
export function fixtureAddressViolations(files: ReadonlyMap<string, string>): string[] {
  return [...files].flatMap(([file, source]) =>
    fixtureAddressLines(source).map((line) => `${file}:${line}: a fixture address on a non-reserved domain; use example.com, *.example, *.invalid, *.test, *.localhost or *.local`));
}

export function repositoryReader(root: string): (path: string) => string | undefined {
  return (path) => {
    const absolute = resolve(root, path);
    return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : undefined;
  };
}
