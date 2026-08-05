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

/**
 * Every entry point that reaches the NAME ladder, in ONE list.
 *
 * The two tests below both need this set, and they used to carry two
 * copies of it. They drifted at the C3 integration and the drift was a
 * false RED: phase 4 added `resolveDelegationConsentOr` and taught the
 * first test about it, while the second test's skip condition still named
 * only the original two — so `delegations/preview/+server.ts`, which is
 * correctly authorized through that resolver, was reported as a route
 * that "delegates to nothing". Neither branch failed alone; the merge
 * produced the combination.
 *
 * One list, both readers. A new resolver is now one edit, and a resolver
 * this file does not know about fails BOTH tests together rather than
 * making them disagree.
 *
 * `resolveDelegationConsentOr` resolves a workflow by NAME exactly like
 * the other two, but authorizes as the principal the DELEGATION will
 * carry rather than as the caller — a distinction `resolveWorkflowOr`
 * structurally cannot express, since it takes an `AuthUser` and a
 * service-account principal has none. Still one adapter in
 * `workflow-access.ts:166` over one rule in
 * `runtime/workflow-delegation-consent.ts`, which is the property this
 * file defends: the entry point is new, the ladder is not.
 */
const NAME_LADDER_RESOLVERS = [
  "resolveWorkflowOr",
  "listVisibleWorkflows",
  "resolveDelegationConsentOr",
] as const;

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
      expect(source).not.toMatch(/\breadRunAudience\b/);
      expect(source).not.toMatch(/\bresolveWorkflowForCaller\b/);
    },
  );

  test.each(files.map((f) => [f.slice(ROUTES_DIR.length + 1), f]))(
    "%s reaches the ladder through the shared access module",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      const usesResolver = NAME_LADDER_RESOLVERS.some((r) => source.includes(r));
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
        source.includes("listPendingWorkflowApprovalsForUser") ||
        // The run-TRACE read pair. Same narrowing, same single-homing:
        // both resolve no workflow by name, and both authorize through
        // `mayControlRun` inside `workflow-run-trace.ts` — the identical
        // predicate `resumeParkedRun` / `cancelParkedRun` use, exported
        // from `workflow-run-control.ts` so there is one opinion about
        // who a run belongs to rather than two that agree today.
        source.includes("getWorkflowRunTrace") ||
        source.includes("listWorkflowRunsForCaller") ||
        // C3's revoke route is keyed by a DELEGATION id and resolves no
        // workflow by name, so the name-ladder decides nothing for it.
        // Its axis is the delegation's CONSENTING HUMAN, single-homed in
        // `mayManageDelegation` — the delegation-shaped twin of
        // `mayControlRun`. Keyed on `consented_by_user_id` rather than on
        // the owner columns on purpose: a service-account delegation has
        // no session of its own, so keying on the owner would leave an
        // authority nobody could withdraw.
        source.includes("mayManageDelegation") ||
        // …and the delegation LIST route, whose whole query is scoped to
        // the consenting human by `consented_by_user_id`. Same axis, same
        // single home; named separately so a list that stopped scoping
        // itself fails here rather than riding on the revoke's name.
        source.includes("listWorkflowDelegationsConsentedBy");

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
      /answerApproval|resumeParkedRun|cancelParkedRun|listPendingWorkflowApprovalsForUser|getWorkflowRunTrace|listWorkflowRunsForCaller|mayManageDelegation|listWorkflowDelegationsConsentedBy/;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (NAME_LADDER_RESOLVERS.some((r) => source.includes(r))) continue;
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
