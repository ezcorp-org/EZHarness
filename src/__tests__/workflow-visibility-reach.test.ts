/**
 * What a workflow's visibility actually buys you, pinned as a fact rather
 * than claimed in a comment.
 *
 * The gap this file exists to keep visible: `visibility: "private"` is the
 * only tier whose read/run audience is narrower than "every user on the
 * instance", and **nothing in the tree writes it**. So every workflow that
 * can exist is readable and runnable by every authenticated principal, and
 * the ladder — real as it is on the EDIT axis — has no confidentiality
 * boundary on the read/run axis at all.
 *
 * That was true before this file existed, and was written down in
 * `workflow-scope.ts`'s own header the whole time. It still nearly shipped
 * a delegated-execution feature (C3) resting on a bound of "could the
 * owner run it?" — a bound that excludes nothing when the answer is always
 * yes. A comment did not stop that. A red test will.
 *
 * The two halves are deliberately different KINDS of check and neither is
 * sufficient alone:
 *
 *  - The producer sweep is STRUCTURAL. It reads the tree for visibility
 *    literals, so it fails when someone adds a writer — including a writer
 *    of `private`, which would make confidentiality reachable and every
 *    "reach is total" statement below stale.
 *  - The reach assertions are BEHAVIOURAL. They drive the real ladder and
 *    fail if the audience of a producible tier ever changes.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  authorizeWorkflow,
  readRunAudience,
  systemCachedWorkflow,
  type CachedWorkflow,
  type WorkflowCaller,
} from "../runtime/workflow-scope";
import type { WorkflowDefinition, WorkflowVisibility } from "../types";

const REPO_ROOT = join(import.meta.dir, "../..");
const SCAN_ROOTS = [join(REPO_ROOT, "src"), join(REPO_ROOT, "web/src")];

/** Every visibility literal the type admits, so the sweep can be exhaustive. */
const ALL_VISIBILITIES: readonly WorkflowVisibility[] = ["system", "project", "private"];

function isTestPath(path: string): boolean {
  return (
    path.includes("__tests__") ||
    path.includes(".test.") ||
    path.includes("/e2e/") ||
    path.endsWith(".spec.ts")
  );
}

/** Every non-test source file that could assign a visibility. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".svelte-kit") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|svelte)$/.test(entry) && !isTestPath(full)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = SCAN_ROOTS.flatMap(sourceFiles);

/**
 * A `visibility: "<literal>"` ASSIGNMENT.
 *
 * Assignments only. `entry.visibility === "private"` is the ladder READING
 * a tier and must not count as producing one, or the sweep would report
 * `private` reachable on the strength of the very code that refuses it.
 * `visibility?: "system" | ...` (a type declaration) is excluded by the
 * same rule: the `?` means the character before the colon is not `y`.
 */
const ASSIGNMENT = /(?<![?\w])visibility:\s*"(system|project|private)"/;

/**
 * Producers found on one line of source, or none if the line is prose.
 *
 * Comments are excluded because the tiers are DISCUSSED at length in
 * `workflow-scope.ts` and `types.ts` — including, necessarily, the very
 * sentence recording that nothing writes `private`. A sweep that counted
 * prose would read that sentence as its own refutation.
 */
function assignmentOn(line: string): WorkflowVisibility | null {
  const match = ASSIGNMENT.exec(line);
  if (!match) return null;
  if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return null;
  if (line.slice(0, match.index).includes("//")) return null;
  return match[1] as WorkflowVisibility;
}

function producedVisibilities(): Map<WorkflowVisibility, string[]> {
  const found = new Map<WorkflowVisibility, string[]>();
  for (const file of FILES) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const tier = assignmentOn(line);
      if (tier === null) continue;
      const at = found.get(tier) ?? [];
      at.push(file.slice(REPO_ROOT.length + 1));
      found.set(tier, at);
    }
  }
  return found;
}

const PRODUCED = producedVisibilities();

describe("the producer sweep", () => {
  test("walks a real tree (a sweep over zero files would pass forever)", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain(join(REPO_ROOT, "src/db/queries/workflows.ts"));
    expect(FILES).toContain(
      join(REPO_ROOT, "web/src/routes/api/workflows/[name]/fork/+server.ts"),
    );
  });

  test("excludes test files, so a fixture cannot make a tier look reachable", () => {
    expect(FILES.some(isTestPath)).toBe(false);
    expect(isTestPath(join(REPO_ROOT, "src/__tests__/workflow-scope.test.ts"))).toBe(true);
  });

  test("counts an assignment", () => {
    expect(assignmentOn('    visibility: "project",')).toBe("project");
    expect(assignmentOn('  visibility: ownership.visibility ?? ("system" as V),')).toBe(null);
  });

  test("does not count the ladder's own comparisons", () => {
    // The ladder compares `private` and produces it never. If the pattern
    // counted reads, this file's headline finding would invert.
    const ladder = readFileSync(join(REPO_ROOT, "src/runtime/workflow-scope.ts"), "utf8");
    expect(ladder).toContain('entry.visibility === "private"');
    expect(assignmentOn('  if (entry.visibility === "private") {')).toBe(null);
  });

  test("does not count a type declaration", () => {
    expect(assignmentOn('\tvisibility?: "system" | "project" | "private";')).toBe(null);
  });

  test("does not count prose that merely names a tier", () => {
    // Discrimination for the comment rule: the SAME text counts when it
    // is code and not when it is a comment.
    expect(assignmentOn(' * nothing writes `visibility: "private"` today')).toBe(null);
    expect(assignmentOn('// visibility: "private",')).toBe(null);
    expect(assignmentOn('const x = { visibility: "private" }; // a real writer')).toBe("private");
  });
});

describe("which visibilities any code path can actually produce", () => {
  test("`system` is produced — the create route and the ownerless cache wrapper", () => {
    expect(PRODUCED.get("system")).toContain("src/runtime/workflow-scope.ts");
    expect(PRODUCED.get("system")?.length).toBeGreaterThan(0);
  });

  test("`project` is produced — fork, and the admin claim", () => {
    const at = PRODUCED.get("project") ?? [];
    expect(at).toContain("web/src/routes/api/workflows/[name]/fork/+server.ts");
    expect(at).toContain("src/db/queries/workflows.ts");
  });

  test("`private` has NO producer — the one confidential tier is unreachable", () => {
    // If this fails, someone made `private` writable. Good — but every
    // "reach is total" claim below and in `workflow-scope.ts`'s header is
    // now stale and must be re-derived, and C3's owner-bound may finally
    // exclude something.
    expect(PRODUCED.get("private")).toBeUndefined();
  });

  test("the sweep has an opinion about every tier the type admits", () => {
    // Guards against a fourth visibility landing in `WorkflowVisibility`
    // and silently escaping this file's analysis.
    expect(ALL_VISIBILITIES).toEqual(["system", "project", "private"]);
    expect(ALL_VISIBILITIES.filter((v) => PRODUCED.has(v))).toEqual(["system", "project"]);
  });
});

const DEFINITION = { name: "wf", description: "", steps: [] } as unknown as WorkflowDefinition;

function entry(visibility: WorkflowVisibility): CachedWorkflow {
  return {
    definition: DEFINITION,
    source: "db",
    id: "wf-1",
    projectId: "project-owned-by-someone-else",
    userId: "owner",
    visibility,
    forkedFrom: null,
  };
}

/** Reachable rows, exactly the tiers the sweep found a producer for. */
const REACHABLE = (ALL_VISIBILITIES.filter((v) => PRODUCED.has(v)) as WorkflowVisibility[]).map(
  entry,
);

/** A nobody: logged in, owns nothing, admins nothing, names a foreign project. */
const STRANGER: WorkflowCaller = {
  userId: "stranger",
  role: "member",
  projectId: "some-other-project",
};

describe("what a read/run grant is actually worth today", () => {
  test("the reachable set under test is non-empty and excludes `private`", () => {
    expect(REACHABLE.map((e) => e.visibility)).toEqual(["system", "project"]);
  });

  test("a stranger may RUN every workflow that can exist", () => {
    // This is the R-1 finding stated as an executable fact. It is the
    // answer to "what would a delegated fire bounded by the owner's own
    // run rights reach?" — everything.
    for (const e of REACHABLE) {
      expect(authorizeWorkflow(e, STRANGER, "run")).toEqual({ ok: true, entry: e });
    }
  });

  test("...and may READ every one of them", () => {
    for (const e of REACHABLE) {
      expect(authorizeWorkflow(e, STRANGER, "read")).toEqual({ ok: true, entry: e });
    }
  });

  test("no reachable tier resolves to the confidential audience", () => {
    for (const e of REACHABLE) {
      expect(readRunAudience(e.visibility)).not.toBe("owner-and-admins");
    }
    // Discrimination: the assertion above is not vacuously true of every
    // input. `private` DOES resolve to it — it is merely unreachable.
    expect(readRunAudience("private")).toBe("owner-and-admins");
  });

  test("the unreachable tier is the only one that would deny that stranger", () => {
    // Proves the grants above come from the audience and not from a
    // ladder that says yes to everything.
    expect(authorizeWorkflow(entry("private"), STRANGER, "run")).toEqual({
      ok: false,
      reason: "not-owner",
    });
    expect(authorizeWorkflow(entry("private"), STRANGER, "read")).toEqual({
      ok: false,
      reason: "not-owner",
    });
  });

  test("EDIT is where a reachable tier genuinely refuses that stranger", () => {
    // The ladder is not decorative — it is an EDIT ladder. Stated here so
    // "no confidentiality boundary" is not misread as "no boundary".
    expect(authorizeWorkflow(entry("system"), STRANGER, "edit")).toEqual({
      ok: false,
      reason: "requires-admin",
    });
    expect(authorizeWorkflow(entry("project"), STRANGER, "edit")).toEqual({
      ok: false,
      reason: "not-owner",
    });
  });
});

describe("`project` visibility is not scoped by any project id", () => {
  const projectEntry = entry("project");

  test("the caller's project id changes no read/run decision", () => {
    // A reader seeing `projectId` on both the caller and the entry will
    // assume they are compared. They are not — and they must not be:
    // `caller.projectId` arrives from the request, so a caller names
    // their own project and any comparison is a boundary the attacker
    // controls. Pinned so a future "tightening" that adds the comparison
    // has to argue with a test rather than look like an improvement.
    const matching: WorkflowCaller = { ...STRANGER, projectId: projectEntry.projectId };
    const absent: WorkflowCaller = { userId: "stranger", role: "member" };
    for (const caller of [STRANGER, matching, absent]) {
      expect(authorizeWorkflow(projectEntry, caller, "run").ok).toBe(true);
    }
  });

  test("the entry's project id changes no read/run decision", () => {
    for (const projectId of ["some-other-project", "any-string-at-all", null]) {
      expect(authorizeWorkflow({ ...projectEntry, projectId }, STRANGER, "run").ok).toBe(true);
    }
  });

  test("a fork with no project is still `project`-visible to everyone", () => {
    // The fork route's `projectId` is optional, so a fork can be
    // `visibility: "project"` with `project_id = NULL` — a project
    // workflow belonging to no project. It is readable by everyone, same
    // as any other.
    const orphan = { ...projectEntry, projectId: null };
    expect(authorizeWorkflow(orphan, STRANGER, "read").ok).toBe(true);
  });

  test("the userless CLI is the ONLY principal `project` excludes", () => {
    // The entire difference between `system` and `project` on read/run.
    // Not a confidentiality boundary: it separates "has a login" from
    // "has no login", not one user from another.
    const cli: WorkflowCaller = { userId: null, role: "member" };
    expect(authorizeWorkflow(projectEntry, cli, "run")).toEqual({
      ok: false,
      reason: "not-authenticated",
    });
    expect(authorizeWorkflow(systemCachedWorkflow(DEFINITION, "yaml"), cli, "run").ok).toBe(true);
  });
});
