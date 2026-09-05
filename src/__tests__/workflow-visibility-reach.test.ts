/**
 * What a workflow's visibility actually buys you, pinned as a fact rather
 * than claimed in a comment.
 *
 * The gap this file was written for: `visibility: "private"` is the only
 * tier whose read/run audience is narrower than "every user on the
 * instance", and for a while **nothing in the tree wrote it**. Every
 * workflow that could exist was readable and runnable by every
 * authenticated principal, and the ladder — real as it is on the EDIT
 * axis — had no confidentiality boundary on the read/run axis at all.
 * That was written down in `workflow-scope.ts`'s own header the whole
 * time, and a comment still did not stop a delegated-execution feature
 * (C3) being planned on a bound of "could the owner run it?" — a bound
 * that excludes nothing when the answer is always yes.
 *
 * `visibility` is now a selectable key on the create/update body, so the
 * gap is closed and this file's job changes rather than ends: it pins
 * WHICH tiers a caller can actually reach and what each one is worth,
 * so the next such claim is a red test rather than stale prose.
 *
 * The two halves are deliberately different KINDS of check and neither is
 * sufficient alone:
 *
 *  - The producer sweep is STRUCTURAL. It reads the tree for the two ways
 *    a tier gets written — a literal assignment in source, and a tier the
 *    request schema lets a CALLER name — so it fails when either set
 *    changes.
 *  - The reach assertions are BEHAVIOURAL. They drive the real ladder and
 *    fail if the audience of a producible tier ever changes.
 *
 * The second kind of producer is here because of a near miss: the change
 * that made `private` selectable added an enum member and a pass-through
 * (`visibility: body.visibility`) and changed no assignment anywhere. A
 * sweep that read only literals stayed green on it, still asserting the
 * tier had no producer — the precise failure this file exists to prevent,
 * committed by this file.
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

/** The body schema every workflow create/update is parsed against. */
const SCHEMA_PATH = "web/src/routes/api/workflows/schema.ts";
/** The create route, which forwards the caller's choice to the writer. */
const CREATE_ROUTE_PATH = "web/src/routes/api/workflows/+server.ts";
/** The pass-through that makes the schema's enum an actual producer. */
const FORWARDS_CHOICE = "visibility: body.visibility";

/**
 * The copy route (the single Duplicate verb), whose DEFAULT tier is a
 * third kind of producer.
 *
 * It used to be an ordinary `visibility: "project"` assignment and the
 * literal sweep saw it. Now the tier is either the caller's (already
 * counted through the schema) or a named default, and a sweep that read
 * only assignments would report the copy route as producing NOTHING —
 * silently losing the one producer whose value was the point of the
 * change. Same failure mode the schema reader was added for, one rung
 * along: a default is as much a writer as an assignment is.
 */
const COPY_ROUTE_PATH = "web/src/routes/api/workflows/[name]/fork/+server.ts";
const COPY_DEFAULT = /DEFAULT_COPY_VISIBILITY\s*=\s*"(system|project|private)"/;
/** The fallback that makes the constant above an actual producer. */
const APPLIES_DEFAULT = "?? DEFAULT_COPY_VISIBILITY";

/** The tier the copy route stamps when the caller names none. */
function copyRouteDefault(): WorkflowVisibility | null {
  const src = readFileSync(join(REPO_ROOT, COPY_ROUTE_PATH), "utf8");
  const found = COPY_DEFAULT.exec(src)?.[1];
  if (found === undefined) return null;
  // Inert unless something falls back to it — the same discrimination the
  // schema producer gets from `FORWARDS_CHOICE`.
  return src.includes(APPLIES_DEFAULT) ? (found as WorkflowVisibility) : null;
}

/**
 * The tiers a CALLER may name, read off the request schema's enum.
 *
 * The producer a literal sweep cannot see. `.strict()` on the body schema
 * means this enum is the whole of what a caller can send, so its members
 * are exactly the tiers reachable from outside — no matter that the
 * string never appears as an assignment anywhere in the tree.
 */
function schemaAdmitted(): WorkflowVisibility[] {
  const src = readFileSync(join(REPO_ROOT, SCHEMA_PATH), "utf8");
  const enumBody = /visibility:\s*z\.enum\(\[([^\]]*)\]\)/.exec(src)?.[1];
  if (enumBody === undefined) return [];
  return ALL_VISIBILITIES.filter((tier) => enumBody.includes(`"${tier}"`));
}

function producedVisibilities(): Map<WorkflowVisibility, string[]> {
  const found = new Map<WorkflowVisibility, string[]>();
  const record = (tier: WorkflowVisibility, where: string) => {
    const at = found.get(tier) ?? [];
    at.push(where);
    found.set(tier, at);
  };
  for (const file of FILES) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const tier = assignmentOn(line);
      if (tier === null) continue;
      record(tier, file.slice(REPO_ROOT.length + 1));
    }
  }
  for (const tier of schemaAdmitted()) record(tier, SCHEMA_PATH);
  const copyDefault = copyRouteDefault();
  if (copyDefault !== null) record(copyDefault, COPY_ROUTE_PATH);
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

  test("`project` is produced — the admin claim, and a caller who names it", () => {
    const at = PRODUCED.get("project") ?? [];
    expect(at).toContain("src/db/queries/workflows.ts");
    expect(at).toContain(SCHEMA_PATH);
  });

  test("the COPY verb no longer produces `project` by default", () => {
    // The change worth pinning. `POST …/fork` stamped `project`
    // unconditionally, and `project` is "any-authenticated-principal" —
    // every account on the instance. So making a copy published it, with
    // nothing in the request saying so. Nothing about the copy path
    // reaches `project` on its own any more; a caller has to ask.
    expect(PRODUCED.get("project") ?? []).not.toContain(COPY_ROUTE_PATH);
    expect(copyRouteDefault()).toBe("private");
  });

  test("`private` is produced by author choice, copy default and owner-bound release assets", () => {
    expect([...(PRODUCED.get("private") ?? [])].sort()).toEqual(
      [SCHEMA_PATH, COPY_ROUTE_PATH, "src/runtime/workflow-release-assets.ts"].sort(),
    );
  });

  test("the schema is not inert — the create route forwards what it admits", () => {
    // Discrimination for the producer above. An enum a caller can send
    // but no writer reads would produce nothing, and counting it would
    // report a reach that does not exist.
    expect(readFileSync(join(REPO_ROOT, CREATE_ROUTE_PATH), "utf8")).toContain(FORWARDS_CHOICE);
  });

  test("the copy default is not inert — the route actually falls back to it", () => {
    // Same discrimination, for the third producer kind. A named constant
    // nothing reads writes no rows, and counting it would report a reach
    // that does not exist.
    expect(readFileSync(join(REPO_ROOT, COPY_ROUTE_PATH), "utf8")).toContain(APPLIES_DEFAULT);
  });

  test("the schema sweep reads the real enum, not any `visibility:` line", () => {
    // Proves the finding above comes from parsing the enum members. If
    // the regex silently stopped matching, `schemaAdmitted` would return
    // [] and `private` would go back to looking unreachable.
    expect(schemaAdmitted()).toEqual(["system", "project", "private"]);
  });

  test("the sweep has an opinion about every tier the type admits", () => {
    // Guards against a fourth visibility landing in `WorkflowVisibility`
    // and silently escaping this file's analysis.
    expect(ALL_VISIBILITIES).toEqual(["system", "project", "private"]);
    expect(ALL_VISIBILITIES.filter((v) => PRODUCED.has(v))).toEqual([...ALL_VISIBILITIES]);
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

/**
 * A nobody: logged in, owns nothing, admins nothing, and — since
 * `project_members` landed — belongs to a DIFFERENT project than the one
 * `entry()` scopes its rows to. That last field is what makes the
 * project-tier assertions below mean something: a stranger with an empty
 * membership set would be refused by any check that merely required the set
 * to be non-empty.
 */
const STRANGER: WorkflowCaller = {
  userId: "stranger",
  role: "member",
  projectId: "some-other-project",
  projectMemberships: ["some-other-project"],
};

/**
 * The reachable set split by what its audience actually admits — derived
 * from the ladder, never hardcoded. If a tier's audience changes, the
 * split moves with it and the assertions below keep meaning what they
 * say instead of quietly testing the wrong tier.
 *
 * Three buckets since the membership split, not two. `project` used to sit
 * in `OPEN` beside `system`; a project-SCOPED `project` row now has its own
 * audience, and folding it back into either bucket would make one of these
 * loops assert the opposite of what its name says.
 */
const byAudience = (want: string) =>
  REACHABLE.filter((e) => readRunAudience(e.visibility, e.projectId) === want);
const OPEN = byAudience("anyone");
const PROJECT_SCOPED = byAudience("project-members-and-admins");
const CONFIDENTIAL = byAudience("owner-and-admins");

describe("what a read/run grant is actually worth today", () => {
  test("the reachable set under test is every tier, and the split is non-vacuous", () => {
    expect(REACHABLE.map((e) => e.visibility)).toEqual(["system", "project", "private"]);
    // Every loop below has something in it. A split that emptied one side
    // would pass those loops by testing nothing.
    expect(OPEN.map((e) => e.visibility)).toEqual(["system"]);
    expect(PROJECT_SCOPED.map((e) => e.visibility)).toEqual(["project"]);
    expect(CONFIDENTIAL.map((e) => e.visibility)).toEqual(["private"]);
  });

  test("a stranger may still RUN and READ anything `system`", () => {
    // What is LEFT of the R-1 finding. `system` is still the tier that
    // admits every user on the instance — and it is still the tier a
    // create DEFAULTS to, so a delegated fire bounded by the owner's own
    // run rights is only as narrow as the author's choice.
    for (const e of OPEN) {
      expect(authorizeWorkflow(e, STRANGER, "run")).toEqual({ ok: true, entry: e });
      expect(authorizeWorkflow(e, STRANGER, "read")).toEqual({ ok: true, entry: e });
    }
  });

  test("a project-scoped row is now refused to a non-member on BOTH axes", () => {
    // The half of the R-1 finding that CLOSED. This loop used to assert
    // the opposite — that a stranger could run and read every `project`
    // row — because there was no membership model to consult.
    for (const e of PROJECT_SCOPED) {
      expect(authorizeWorkflow(e, STRANGER, "run")).toEqual({
        ok: false,
        reason: "not-project-member",
        visibility: e.visibility,
      });
      expect(authorizeWorkflow(e, STRANGER, "read")).toEqual({
        ok: false,
        reason: "not-project-member",
        visibility: e.visibility,
      });
    }
  });

  test("...and admitted to a member of that project — the refusal is the scope's", () => {
    // Discrimination for the loop above: the stranger is not simply
    // refused everything, and the row is not simply unreachable.
    for (const e of PROJECT_SCOPED) {
      const insider: WorkflowCaller = {
        userId: "some-member",
        role: "member",
        projectId: null,
        projectMemberships: [e.projectId as string],
      };
      expect(authorizeWorkflow(e, insider, "run").ok).toBe(true);
      expect(authorizeWorkflow(e, insider, "read").ok).toBe(true);
    }
  });

  test("`private` is the per-USER confidentiality boundary, and it is reachable", () => {
    // The half of this file that used to say "no reachable tier is
    // confidential". A stranger is refused a private row on BOTH axes,
    // and — unlike before — a caller can actually produce one.
    for (const e of CONFIDENTIAL) {
      // The denial names the tier it was refused on, because
      // `denialStatus` needs it to hide a `private` row's existence on
      // the write verbs too. See `workflow-scope.test.ts`.
      const denied = { ok: false, reason: "not-owner", visibility: "private" } as const;
      expect(authorizeWorkflow(e, STRANGER, "run")).toEqual(denied);
      expect(authorizeWorkflow(e, STRANGER, "read")).toEqual(denied);
    }
  });

  test("the refusal is the tier's, not the stranger's — its owner is admitted", () => {
    // Discrimination: proves the denials above come from the audience
    // rather than from a ladder that refuses this caller everything.
    for (const e of CONFIDENTIAL) {
      expect(
        authorizeWorkflow(
          e,
          { userId: e.userId, role: "member", projectMemberships: [] },
          "run",
        ).ok,
      ).toBe(true);
      expect(
        authorizeWorkflow(
          e,
          { userId: "someone-else", role: "admin", projectMemberships: [] },
          "run",
        ).ok,
      ).toBe(true);
    }
  });

  test("EDIT is where a reachable tier genuinely refuses that stranger", () => {
    // The ladder is not decorative — it is an EDIT ladder. Stated here so
    // "no confidentiality boundary" is not misread as "no boundary".
    expect(authorizeWorkflow(entry("system"), STRANGER, "edit")).toEqual({
      ok: false,
      reason: "requires-admin",
      visibility: "system",
    });
    expect(authorizeWorkflow(entry("project"), STRANGER, "edit")).toEqual({
      ok: false,
      reason: "not-owner",
      visibility: "project",
    });
  });
});

describe("`project` visibility is scoped by the ROW's project id — never the caller's", () => {
  const projectEntry = entry("project");

  test("the caller's project id changes no read/run decision", () => {
    // A reader seeing `projectId` on both the caller and the entry will
    // assume they are compared. They are still NOT — and they still must
    // not be: `caller.projectId` arrives from the request, so a caller
    // names their own project and any comparison is a boundary the
    // attacker controls. The membership model did not change this; it
    // added a SECOND, server-resolved field that is compared instead.
    //
    // Every caller below carries the same memberships (none of the
    // entry's project) and differs only in the id it CLAIMS. All three
    // are refused, including the one whose claim matches exactly.
    const matching: WorkflowCaller = { ...STRANGER, projectId: projectEntry.projectId };
    const absent: WorkflowCaller = {
      userId: "stranger",
      role: "member",
      projectMemberships: ["some-other-project"],
    };
    for (const caller of [STRANGER, matching, absent]) {
      expect(authorizeWorkflow(projectEntry, caller, "run")).toEqual({
        ok: false,
        reason: "not-project-member",
        visibility: "project",
      });
    }
  });

  test("the ENTRY's project id is what moves the decision", () => {
    // The mirror of the test above, and the pair is the whole point: one
    // id is decision-irrelevant, the other decides. Same caller
    // throughout; only the row's scope moves.
    const insider: WorkflowCaller = {
      userId: "member-of-a",
      role: "member",
      projectId: null,
      projectMemberships: ["project-a"],
    };
    expect(authorizeWorkflow({ ...projectEntry, projectId: "project-a" }, insider, "run").ok).toBe(
      true,
    );
    expect(authorizeWorkflow({ ...projectEntry, projectId: "project-b" }, insider, "run").ok).toBe(
      false,
    );
    // …and a row scoped to NO project has no membership question at all.
    expect(authorizeWorkflow({ ...projectEntry, projectId: null }, insider, "run").ok).toBe(true);
  });

  test("a fork with no project is still `project`-visible to everyone", () => {
    // The fork route's `projectId` is optional, so a fork can be
    // `visibility: "project"` with `project_id = NULL` — a project
    // workflow belonging to no project. It stays readable by everyone,
    // because there is no project to be a member of; gating it would
    // refuse every principal rather than narrow anything.
    const orphan = { ...projectEntry, projectId: null };
    expect(authorizeWorkflow(orphan, STRANGER, "read").ok).toBe(true);
  });

  test("the userless CLI is excluded from `project` on both shapes", () => {
    // Refused for the reason that applies to IT — no identity to key a
    // membership by — rather than for `not-project-member`, which would
    // describe a lookup that could never have succeeded.
    const cli: WorkflowCaller = { userId: null, role: "member", projectMemberships: [] };
    expect(authorizeWorkflow(projectEntry, cli, "run")).toEqual({
      ok: false,
      reason: "not-authenticated",
      visibility: "project",
    });
    expect(authorizeWorkflow({ ...projectEntry, projectId: null }, cli, "run")).toEqual({
      ok: false,
      reason: "not-authenticated",
      // Dropping the project id changes the AUDIENCE, not the tier — the
      // denial still names `project`, which is the row it was refused on.
      visibility: "project",
    });
    expect(authorizeWorkflow(systemCachedWorkflow(DEFINITION, "yaml"), cli, "run").ok).toBe(true);
  });
});
