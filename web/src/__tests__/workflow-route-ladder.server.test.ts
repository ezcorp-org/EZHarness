/**
 * Acceptance criterion 1: workflow authorization lives in ONE resolver,
 * not per-route.
 *
 * This is a structural test rather than a behavioural one on purpose. The
 * behavioural matrix in `src/__tests__/workflow-scope.test.ts` proves the
 * ladder is CORRECT; nothing there would notice a seventh route quietly
 * growing its own `entry.visibility === "system"` check next to the
 * shared one. Two implementations of an authorization rule is a rule that
 * is wrong in at least one of them, and the wrong one is the one nobody
 * re-reads.
 *
 * So: every handler under `routes/api/workflows/**` must reach the ladder
 * through `resolveWorkflowOr` / `listVisibleWorkflows`, and none of them
 * may mention `visibility` at all.
 */
import { test, expect, describe } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = join(process.cwd(), "src/routes/api/workflows");

function handlerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...handlerFiles(full));
    } else if (entry === "+server.ts") {
      out.push(full);
    }
  }
  return out;
}

const files = handlerFiles(ROUTES_DIR);

describe("the workflow ownership ladder lives in exactly one place", () => {
  test("every workflow route file is discovered (the sweep is not vacuous)", () => {
    // A test that walked an empty directory would pass forever.
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  test.each(files.map((f) => [f.slice(ROUTES_DIR.length + 1), f]))(
    "%s contains no visibility COMPARISON of its own",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      // Reading a visibility to decide something is the drift this test
      // exists to catch. WRITING one is fine and expected — the fork
      // route stamps `visibility: "project"` on the row it creates, which
      // is ownership assignment, not an authorization decision.
      expect(source).not.toMatch(/visibility\s*[=!]==/);
      expect(source).not.toMatch(/[=!]==\s*["'](?:system|project|private)["']/);
      expect(source).not.toMatch(/\bvisibility\s*(?:===|!==|==|!=)/);
    },
  );

  test.each(files.map((f) => [f.slice(ROUTES_DIR.length + 1), f]))(
    "%s does not import the ladder module directly",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      // `runtime/workflow-scope` is the ladder itself. Routes reach it
      // ONLY through `$lib/server/workflow-access`, so there is one
      // adapter to audit rather than seven call sites.
      expect(source).not.toMatch(/from\s+["'][^"']*workflow-scope["']/);
      expect(source).not.toMatch(/\bauthorizeWorkflow\b/);
      expect(source).not.toMatch(/\bisProjectMember\b/);
      expect(source).not.toMatch(/\bresolveWorkflowForCaller\b/);
    },
  );

  test.each(files.map((f) => [f.slice(ROUTES_DIR.length + 1), f]))(
    "%s reaches the ladder through the shared access module",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      const usesResolver =
        source.includes("resolveWorkflowOr") || source.includes("listVisibleWorkflows");
      // The claim route is the ONE deliberate exception: it is an
      // admin-only ownership MOVE, gated on the role/scope axes rather
      // than on a workflow's current owner (whose whole problem is that
      // it has none). It must still not hand-roll the ladder — which the
      // no-`visibility` assertion above already enforces.
      const isAdminGated = source.includes("requireAdmin");

      // A route keyed by an APPROVAL or RUN id resolves no workflow by
      // name, so the name-ladder has nothing to decide for it. Its
      // authorization axis is the RUN's owner, and that lives — equally
      // single-homed — in `answerApproval` / `workflow-run-control` /
      // the owner-scoped inbox query. This is a narrowing of the rule,
      // not an exemption from it: the route must still delegate to ONE of
      // those, which is asserted positively rather than assumed, so an
      // id-scoped route that authorizes nothing at all still fails here.
      const delegatesToRunAuthority =
        source.includes("answerApproval") ||
        source.includes("resumeParkedRun") ||
        source.includes("cancelParkedRun") ||
        source.includes("listPendingWorkflowApprovalsForUser");

      expect(usesResolver || isAdminGated || delegatesToRunAuthority).toBe(true);
    },
  );

  test("an id-scoped route delegates to a run-owner authority, never to nothing", () => {
    // The other half of the narrowing above, stated as its own property so
    // it cannot be lost inside a three-way OR: every route that does NOT
    // use the name-ladder must name one of the run-owner authorities. A
    // route that reached neither would be open to any authenticated
    // caller, which is precisely the hole the ladder closed for the
    // name-scoped ones.
    const AUTHORITIES =
      /answerApproval|resumeParkedRun|cancelParkedRun|listPendingWorkflowApprovalsForUser/;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (source.includes("resolveWorkflowOr") || source.includes("listVisibleWorkflows")) continue;
      if (source.includes("requireAdmin")) continue;
      expect({ file: file.slice(ROUTES_DIR.length + 1), delegates: AUTHORITIES.test(source) }).toEqual(
        { file: file.slice(ROUTES_DIR.length + 1), delegates: true },
      );
    }
  });

  test("no workflow route reads the raw cache directly", () => {
    // `getCachedWorkflows()` is the resolver's input, not a route's.
    // Reading it in a handler is how a lookup ends up unauthorized.
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toMatch(/getCachedWorkflows\s*\(/);
    }
  });

  test("no workflow route resolves a name with a bare find()", () => {
    // The pre-C6 shape — `getWorkflows().find(w => w.name === params.name)`
    // — is exactly the lookup that could not authorize.
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toMatch(/\.find\(\s*\(\s*w\s*\)/);
    }
  });
});
