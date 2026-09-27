/**
 * Repo-wide guard: every production `git` subprocess spawn declares which of
 * TWO env classes it belongs to, by calling one of the two named functions
 * in `packages/@ezcorp/sdk/src/git/index.ts` (item C2, W18 hygiene).
 *
 * A `Bun.spawn`/`Bun.spawnSync` call whose argv literally starts with
 * `"git"` is a "git spawn." Every one must call either:
 *   - `withoutGitContext()` — the spawn targets an EXPLICIT repository the
 *     caller names (a clone URL, an `ls-remote` URL, a `-C <path>`/`cwd` the
 *     caller chose) — strips ambient `GIT_*` so an inherited `GIT_DIR` (e.g.
 *     from a git hook) can never silently redirect it onto the wrong
 *     repository; or
 *   - `currentRepositoryGitContext()` — the spawn must operate on the
 *     repository AS INVOKED (a gate/coverage script walking the checkout its
 *     own caller already set up, a hook helper that needs the staged view) —
 *     keeps the invoking context untouched, by design.
 * GC5 originally shipped only the first class and converted six gate
 * scripts to it along with the four real wrappers; that was a real
 * regression (validator-3's finding) — those six needed the SECOND class,
 * and stripping their `GIT_*` context broke ten tests that poison the
 * environment specifically to prove those scripts see the STAGED
 * repository state, not a plain `cwd`-discovered one. This guard now checks
 * that every git spawn calls ONE of the two, by name — never neither (an
 * omitted `env` key or a bare `{...process.env}` passthrough, the original
 * bug), and never a THIRD, ad hoc filter that reimplements either rule
 * inline.
 *
 * SCOPE: production code only — `src/`, `scripts/`, `packages/`,
 * `docs/extensions/examples/` — excluding test files (a test's OWN git
 * spawns are a test-isolation concern with its own established pattern,
 * `src/__tests__/helpers/scratch-git.ts`'s `scratchGitEnv()`, not this rule).
 *
 * DETECTION SCOPE, STATED HONESTLY: this walker recognizes a LITERAL argv
 * array whose first element is the string `"git"` — `Bun.spawn(["git", ...])`
 * / `Bun.spawnSync(["git", ...])`. It does NOT (and structurally cannot,
 * without a real parser) recognize a generic passthrough runner that takes
 * an arbitrary `cmd: string[]` parameter and might sometimes be called with
 * a git argv — docs-updater's `makeProductionShell` is exactly this shape,
 * deliberately reused for both `git` and `gh` calls, and is out of this
 * guard's detection reach for that reason (its own env, `hermeticGitEnv()`,
 * already goes through `withoutGitContext()` — checked by the positive
 * fixture at the read-function call sites in the SAME file, not this one).
 *
 * ALSO STATED HONESTLY: this guard is MECHANICAL, not semantic — it checks
 * that a call site names ONE of the two classes, never that it named the
 * CORRECT one for its own contract. A class-B script that mistakenly called
 * `withoutGitContext()` (stripping when it should keep) would still pass.
 * That is exactly the mistake validator-3 caught in the six gate scripts,
 * and this guard could not have caught it either, before or after the fix —
 * choosing the right class for a given call site is a judgment call the
 * poisoned-env tests in `gate-scripts.test.ts` and
 * `check-patch-coverage-typeonly.test.ts` make, not this guard. This guard's
 * job is narrower and still real: a SIXTH call site cannot land calling
 * neither function, or a third, ad hoc, unreviewed filter.
 */
import { test, expect, describe } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");
}

/** Balanced-paren index of the `)` matching the `(` at `openIdx`. */
function matchingParenIndex(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split the (already-balanced) contents of a call's argument list at its
 *  top-level commas — nested `()`, `{}`, `[]` do not split. */
function splitTopLevelArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      args.push(s.slice(start, i));
      start = i + 1;
    }
  }
  args.push(s.slice(start));
  return args;
}

/**
 * Every `Bun.spawn(["git", ...` / `Bun.spawnSync(["git", ...` call's full
 * argument-list text (the literal argv array PLUS the options object, when
 * present) in `source`.
 */
export interface GitSpawnCallsite {
  /** The full argument-list text (the literal argv array PLUS the options
   *  object, when present). */
  argsText: string;
  /** Everything in the (comment-stripped) source BEFORE this call — passed
   *  to declaration resolution so a same-named `const` or `function`
   *  elsewhere in the file (a different scope entirely) can't be mistaken
   *  for the one actually in scope here; the NEAREST preceding declaration
   *  wins, not the first one in the whole file. */
  precedingSource: string;
}

export function findGitSpawnArgLists(source: string): GitSpawnCallsite[] {
  const stripped = stripCommentLines(source);
  const out: GitSpawnCallsite[] = [];
  for (const needle of ["Bun.spawnSync(", "Bun.spawn("]) {
    let from = 0;
    while (true) {
      const at = stripped.indexOf(needle, from);
      if (at === -1) break;
      const openParen = at + needle.length - 1;
      const closeParen = matchingParenIndex(stripped, openParen);
      if (closeParen === -1) {
        from = at + needle.length;
        continue;
      }
      const argsText = stripped.slice(openParen + 1, closeParen);
      const firstArg = (splitTopLevelArgs(argsText)[0] ?? "").trim();
      if (/^\[\s*["']git["']/.test(firstArg)) out.push({ argsText, precedingSource: stripped.slice(0, at) });
      from = closeParen + 1;
    }
  }
  return out;
}

/** The value expression of `key:` inside an object-literal text (balanced
 *  across nested `()`/`{}`/`[]`), or `null` if the key is absent. A bare
 *  shorthand property (`{ env, ... }`, meaning `env: env`) resolves to the
 *  identifier itself. */
export function extractObjectProp(objText: string, key: string): string | null {
  const keyRe = new RegExp(`(?:^|[,{])\\s*${key}\\s*:`);
  const m = keyRe.exec(objText);
  if (m) {
    let i = m.index + m[0].length;
    while (i < objText.length && /\s/.test(objText[i]!)) i++;
    const start = i;
    let depth = 0;
    for (; i < objText.length; i++) {
      const c = objText[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    return objText.slice(start, i).trim();
  }
  const shorthandRe = new RegExp(`(?:^|[,{])\\s*(${key})\\s*(?:,|\\})`);
  const shorthand = shorthandRe.exec(objText);
  return shorthand ? shorthand[1]! : null;
}

/**
 * The RHS of the LAST top-level `const NAME = <expr>;` declaration in
 * `source` (balanced across nested `()`/`{}`/`[]`), or `null` if not
 * declared this way. Same "pass an already-truncated, nearest-preceding
 * source" contract as `resolveFunctionBody` above.
 */
export function resolveConstDecl(source: string, name: string): string | null {
  const declRe = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]*)?=\\s*`, "g");
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source))) lastMatch = m;
  if (lastMatch === null) return null;
  let depth = 0;
  for (let i = lastMatch.index + lastMatch[0].length; i < source.length; i++) {
    const c = source[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) return source.slice(lastMatch.index + lastMatch[0].length, i).trim();
  }
  return null;
}

/**
 * `function NAME(...) { ... }` or `const NAME = (...) => { ... }` (with or
 * without a return-type annotation) — the balanced `{ ... }` body of the
 * LAST such declaration in `source`, or `null` if `name` isn't declared as
 * either shape. Callers pass `source` already truncated to "everything
 * before the reference being resolved" (see `GitSpawnCallsite.precedingSource`),
 * so "last in the given text" means "nearest preceding" — a same-named
 * declaration in a different, unrelated function elsewhere in the file
 * cannot be mistaken for the one actually in scope.
 */
export function resolveFunctionBody(source: string, name: string): string | null {
  const patterns = [
    new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`, "g"),
    new RegExp(`const\\s+${name}\\s*=\\s*\\([^)]*\\)\\s*(?::[^=]*)?=>\\s*\\{`, "g"),
  ];
  let lastMatch: RegExpExecArray | null = null;
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      if (lastMatch === null || m.index > lastMatch.index) lastMatch = m;
    }
  }
  if (lastMatch === null) return null;
  const braceStart = lastMatch.index + lastMatch[0].length - 1;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return null;
}

/**
 * `envExpr` (the value bound to a git-spawn call's `env:` key — a shorthand
 * property resolves to the bare identifier, per `extractObjectProp` — or
 * `null` if the key was absent) is guarded when it calls `withoutGitContext(`
 * OR `currentRepositoryGitContext(` directly — the two named classes, see
 * this file's own top docblock — or resolves — through a same-file helper
 * CALL (`hermeticGitEnv()`) or a same-file VARIABLE declaration (`const env
 * = isolatedGitEnv(home)`, `gitInDirectory()`'s own shape) — to something
 * that calls one of them, recursively (a variable initialized by a helper
 * call whose OWN body calls either is guarded transitively). An absent
 * `env:` key is NEVER guarded — Bun's default "inherit" for an omitted
 * `env` is exactly `unlanded-branches.ts`'s pre-GC5 bug.
 */
export function isGuardedEnvExpr(envExpr: string | null, source: string, depth = 0): boolean {
  if (envExpr === null || depth > 5) return false;
  const e = envExpr.trim();
  if (e.includes("withoutGitContext(") || e.includes("currentRepositoryGitContext(")) return true;

  const call = /^([A-Za-z_$][\w$]*)\([^)]*\)$/.exec(e);
  if (call) {
    const body = resolveFunctionBody(source, call[1]!);
    if (body !== null && isGuardedEnvExpr(body, source, depth + 1)) return true;
  }

  const bareIdent = /^[A-Za-z_$][\w$]*$/.exec(e);
  if (bareIdent) {
    const decl = resolveConstDecl(source, e);
    if (decl !== null && isGuardedEnvExpr(decl, source, depth + 1)) return true;
  }

  return false;
}

describe("git-spawn env guard: fixtures pin the detector before it walks the repo", () => {
  test("a direct withoutGitContext(process.env) call is guarded", () => {
    const src = 'const p = Bun.spawnSync(["git", ...args], { cwd, env: withoutGitContext(process.env) });';
    const argLists = findGitSpawnArgLists(src);
    expect(argLists).toHaveLength(1);
    const envExpr = extractObjectProp(splitTopLevelArgs(argLists[0]!.argsText)[1]!, "env");
    expect(isGuardedEnvExpr(envExpr, argLists[0]!.precedingSource)).toBe(true);
  });

  test("a same-file helper that itself calls withoutGitContext(...) is guarded", () => {
    const src = [
      "function hermeticGitEnv() {",
      "  return { ...withoutGitContext(process.env), GIT_CONFIG_GLOBAL: \"/dev/null\" };",
      "}",
      'const proc = Bun.spawn(["git", "-C", repoPath, "log", "-1"], { stdout: "pipe", env: hermeticGitEnv() });',
    ].join("\n");
    const argLists = findGitSpawnArgLists(src);
    expect(argLists).toHaveLength(1);
    const envExpr = extractObjectProp(splitTopLevelArgs(argLists[0]!.argsText)[1]!, "env");
    expect(envExpr).toBe("hermeticGitEnv()");
    expect(isGuardedEnvExpr(envExpr, argLists[0]!.precedingSource)).toBe(true);
  });

  test("a bare {...process.env} passthrough is a violation — the pre-GC5 gitExec() bug", () => {
    const src = 'const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env } });';
    const argLists = findGitSpawnArgLists(src);
    expect(argLists).toHaveLength(1);
    const envExpr = extractObjectProp(splitTopLevelArgs(argLists[0]!.argsText)[1]!, "env");
    expect(isGuardedEnvExpr(envExpr, argLists[0]!.precedingSource)).toBe(false);
  });

  test("env omitted entirely is a violation — the pre-GC5 unlanded-branches.ts bug", () => {
    const src = 'const p = Bun.spawnSync(["git", ...args], { cwd });';
    const argLists = findGitSpawnArgLists(src);
    expect(argLists).toHaveLength(1);
    const envExpr = extractObjectProp(splitTopLevelArgs(argLists[0]!.argsText)[1]!, "env");
    expect(envExpr).toBeNull();
    expect(isGuardedEnvExpr(envExpr, argLists[0]!.precedingSource)).toBe(false);
  });

  test("a non-git Bun.spawn call is not matched at all", () => {
    const src = 'const p = Bun.spawnSync([bin, path], { stdout: "pipe" });';
    expect(findGitSpawnArgLists(src)).toHaveLength(0);
  });

  test("a bare shorthand env property resolves through its own const declaration (gitInDirectory()'s shape)", () => {
    // The real shape in packages/@ezcorp/sdk/src/test/filesystem.ts: `env` is
    // a shorthand property (no `env:` colon at all), bound one line above to
    // a call to a DIFFERENT helper (isolatedGitEnv) whose own body calls
    // withoutGitContext — two levels of resolution, not one.
    const src = [
      "function isolatedGitEnv(home, env = process.env) {",
      "  const out = withoutGitContext(env);",
      "  return out;",
      "}",
      "function gitInDirectory(cwd, args, home) {",
      "  const env = isolatedGitEnv(home);",
      '  const git = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe" });',
      "}",
    ].join("\n");
    const argLists = findGitSpawnArgLists(src);
    expect(argLists).toHaveLength(1);
    const envExpr = extractObjectProp(splitTopLevelArgs(argLists[0]!.argsText)[1]!, "env");
    expect(envExpr).toBe("env");
    expect(isGuardedEnvExpr(envExpr, argLists[0]!.precedingSource)).toBe(true);
  });

  test("a direct currentRepositoryGitContext(process.env) call is guarded", () => {
    const src = 'const p = Bun.spawnSync(["git", "status"], { cwd, env: currentRepositoryGitContext(process.env) });';
    const argLists = findGitSpawnArgLists(src);
    expect(argLists).toHaveLength(1);
    const envExpr = extractObjectProp(splitTopLevelArgs(argLists[0]!.argsText)[1]!, "env");
    expect(isGuardedEnvExpr(envExpr, argLists[0]!.precedingSource)).toBe(true);
  });

  test("a shorthand env property bound to an unguarded value is still a violation", () => {
    const src = [
      "function unsafeEnv() { return { ...process.env }; }",
      "const env = unsafeEnv();",
      'const p = Bun.spawnSync(["git", ...args], { cwd, env });',
    ].join("\n");
    const argLists = findGitSpawnArgLists(src);
    expect(argLists).toHaveLength(1);
    const envExpr = extractObjectProp(splitTopLevelArgs(argLists[0]!.argsText)[1]!, "env");
    expect(envExpr).toBe("env");
    expect(isGuardedEnvExpr(envExpr, argLists[0]!.precedingSource)).toBe(false);
  });
});

describe("git-spawn env guard: every production git spawn is guarded (item C2, W18 hygiene)", () => {
  test("src/, scripts/, packages/, docs/extensions/examples/ have zero unguarded git spawns", async () => {
    const roots = ["src", "scripts", "packages", "docs/extensions/examples"];
    const files: string[] = [];
    for (const root of roots) {
      for await (const rel of new Glob("**/*.ts").scan({ cwd: join(REPO_ROOT, root) })) {
        if (/\.test\.ts$/.test(rel) || rel.includes("__tests__/") || rel.includes("node_modules/") || rel.startsWith("dist/") || rel.includes("/dist/")) continue;
        files.push(join(REPO_ROOT, root, rel));
      }
    }

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const { argsText, precedingSource } of findGitSpawnArgLists(source)) {
        const optionsArg = splitTopLevelArgs(argsText)[1] ?? null;
        const envExpr = optionsArg ? extractObjectProp(optionsArg, "env") : null;
        if (!isGuardedEnvExpr(envExpr, precedingSource)) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)} (env: ${envExpr ?? "<absent>"})`);
        }
      }
    }

    if (offenders.length > 0) {
      console.error(
        `Unguarded git spawn in: ${offenders.join(", ")}. ` +
          `Route its env through withoutGitContext() (an explicit-target spawn) or ` +
          `currentRepositoryGitContext() (a current-repository spawn) from @ezcorp/sdk/git ` +
          `(directly, or via a same-file helper that itself calls one) — see ` +
          `src/extensions/git.ts's gitExec() and scripts/gate-integrity.ts's gitRun() for the ` +
          `two patterns.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  test("the four known-fixed class-A wrappers are each recognized and guarded (positive fixtures)", () => {
    const fixtures = [
      "src/extensions/git.ts",
      "scripts/unlanded-branches.ts",
      "docs/extensions/examples/docs-updater/index.ts",
      "docs/extensions/examples/repo-activity-notify/index.ts",
    ];
    for (const rel of fixtures) {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      const argLists = findGitSpawnArgLists(source);
      expect(argLists.length).toBeGreaterThan(0);
      for (const { argsText, precedingSource } of argLists) {
        const optionsArg = splitTopLevelArgs(argsText)[1] ?? null;
        const envExpr = optionsArg ? extractObjectProp(optionsArg, "env") : null;
        expect(isGuardedEnvExpr(envExpr, precedingSource)).toBe(true);
      }
    }
  });

  test("the six class-B gate/coverage scripts are each recognized and guarded, and keep the invoking context (positive fixtures)", () => {
    // validator-3's finding: these six were wrongly converted to
    // withoutGitContext() (class A) under GC5's first draft, breaking ten
    // tests that poison the environment to prove these scripts see the
    // STAGED repository state. Pinned here as class B so a regression back
    // to class A fails this specific assertion, not just the blanket
    // zero-unguarded-spawns check above (which cannot tell the two classes
    // apart on its own).
    const fixtures = [
      "scripts/check-boundaries.ts",
      "scripts/check-visual-evidence.ts",
      "scripts/gate-integrity.ts",
      "scripts/git-output.ts",
      "scripts/git-worktree-clean.ts",
      "scripts/verify-browser-coverage-receipt.ts",
    ];
    for (const rel of fixtures) {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      const argLists = findGitSpawnArgLists(source);
      expect(argLists.length).toBeGreaterThan(0);
      for (const { argsText, precedingSource } of argLists) {
        const optionsArg = splitTopLevelArgs(argsText)[1] ?? null;
        const envExpr = optionsArg ? extractObjectProp(optionsArg, "env") : null;
        expect(isGuardedEnvExpr(envExpr, precedingSource)).toBe(true);
      }
      // The class-B check that class-A cannot make: guarded is not enough
      // here — the file must specifically call currentRepositoryGitContext()
      // for its git spawn(s) somewhere, not withoutGitContext() (which would
      // also satisfy the generic isGuardedEnvExpr() check above but
      // silently regress the exact bug validator-3 found). A per-call text
      // match is not reliable here (a shorthand `env` property, as in
      // git-worktree-clean.ts, resolves through a `const` one line above,
      // not the call text itself) — checking the whole file's source is the
      // honest, working version of the same check. (A bare substring check
      // against `withoutGitContext(` would also flag this file's own
      // explanatory prose about why it does NOT call that function, so it
      // is not a reliable negative check and is not attempted here.)
      expect(source).toContain("currentRepositoryGitContext(");
    }
  });
});
