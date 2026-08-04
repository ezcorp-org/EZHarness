/**
 * C3 phase 7 — the SHAPE of `ctx.workflows.runFor`, pinned from the host
 * side.
 *
 * ## Why these are source-text tests, and why they live HERE
 *
 * The security argument for `runFor` is not that the host refuses a
 * caller-supplied principal. It is that a caller-supplied principal has no
 * REPRESENTATION: the params type carries a `jobRef` and an `input`, the
 * owner and the workflow name come off the delegation row, and so "run
 * this as somebody else" is inexpressible rather than denied. A denial is
 * a control that can be got wrong. An absent field cannot be.
 *
 * That property is invisible to every runtime test on both sides. The host
 * would simply ignore an extra `ownerId` key while the SDK's users learned
 * to pass it, and an SDK unit test can only assert about frames the SDK
 * chooses to send. The only thing that fails a build when the field comes
 * back is a test that reads the declaration. Precedent for the technique:
 * the P2 note test in `src/__tests__/workflows-permission.test.ts`, and
 * `audit-regressions.test.ts` reading `registry.ts` to pin a trust-boundary
 * import out of existence.
 *
 * **They live in `src/` deliberately, not beside the SDK's own tests.**
 * `packages/@ezcorp/sdk/test/**` is in NEITHER pass/fail pool: it is not
 * in `passfail_files()` (`scripts/lib/test-file-sets.sh`), and the
 * coverage run's `sdk` leg has its exit code LOGGED rather than gated
 * ("tolerated leg exit codes (not gated)", `scripts/test-coverage.sh`). A
 * pin that cannot red the build is a comment. Everything under `src/**` is
 * swept into both P and C, so these assertions actually stop a merge.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DELEGATION_OWNER_COLUMN } from "../../db/schema";
import { DELEGATED_OP, DELEGATED_WORKFLOWS_METHOD } from "../workflows-handler";

const SDK_WORKFLOWS = resolve(
  import.meta.dir,
  "../../../packages/@ezcorp/sdk/src/runtime/workflows.ts",
);
const HANDLER = resolve(import.meta.dir, "../workflows-handler.ts");

const sdk = readFileSync(SDK_WORKFLOWS, "utf8");
const handler = readFileSync(HANDLER, "utf8");

/** Strip block and line comments so a WORD in prose can never be mistaken
 *  for a field. The absence tests below would otherwise fail merely for
 *  the docs explaining WHY the field is absent — which is exactly the
 *  text a future reader most needs. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The names an interface declares at its TOP level.
 *
 * Returns a verdict for the caller to assert on inline — a helper that
 * asserted for me would hide which half failed, and reads as a
 * vacuous test to the `Gate integrity` check.
 */
function interfaceMembers(source: string, name: string): string[] {
  const bare = stripComments(source);
  const at = bare.indexOf(`interface ${name} {`);
  if (at < 0) return [];
  let depth = 0;
  let end = -1;
  let i = bare.indexOf("{", at);
  const open = i;
  for (; i < bare.length; i += 1) {
    if (bare[i] === "{") depth += 1;
    else if (bare[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const body = bare.slice(open + 1, end);
  // Members at depth 1 only: an identifier followed by an optional `?` and
  // a `:`, with nothing but whitespace/`;` before it on its line.
  const members: string[] = [];
  let nested = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (nested === 0) {
      const m = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
      if (m?.[1]) members.push(m[1]);
    }
    for (const ch of line) {
      if (ch === "{") nested += 1;
      else if (ch === "}") nested -= 1;
    }
  }
  return members;
}

describe("WorkflowRunForParams — the two fields, and the ones that must never appear", () => {
  test("it declares EXACTLY jobRef and input", () => {
    expect(interfaceMembers(sdk, "WorkflowRunForParams").sort()).toEqual(["input", "jobRef"]);
  });

  test("NO owner / user / principal field — the owner comes off the delegation row", () => {
    // The load-bearing one. `workflow_delegations.owner_kind` +
    // `owner_user_id` / `owner_service_account_id` are the ONLY source of
    // the principal, resolved host-side from an extension id the REGISTRY
    // supplied. A field here would be a second source, supplied by the
    // caller, for the thing the whole ladder authorizes — and it would be
    // load-bearing on the first fire, because nothing downstream would
    // know it was not meant to be trusted.
    const members = interfaceMembers(sdk, "WorkflowRunForParams");
    expect(members.length).toBeGreaterThan(0);
    const principalish = members.filter((m) =>
      /user|owner|principal|behalf|account|as$|actor|identity|role|admin/i.test(m),
    );
    expect(principalish).toEqual([]);
  });

  test("NO workflow-name field either (R-5) — the name comes off the same row", () => {
    // A name on the wire would be a second, weaker source of truth for the
    // thing the ladder authorizes, and would have to be reconciled against
    // the row on every fire. Deleting the field deletes the question —
    // which is why the host's spec deleted rung D5 along with it.
    const members = interfaceMembers(sdk, "WorkflowRunForParams");
    expect(members.length).toBeGreaterThan(0);
    const nameish = members.filter((m) => /workflow|name|project/i.test(m));
    expect(nameish).toEqual([]);
  });

  test("the METHOD takes that one params object and nothing beside it", () => {
    // The params type staying clean buys nothing if a second argument
    // carries the principal instead. Pin the whole signature: one
    // parameter, that type, that return type.
    const signatures = stripComments(sdk).match(/async runFor\s*\([^)]*\)\s*:[^{]*\{/g) ?? [];
    expect(signatures).toEqual([
      "async runFor(params: WorkflowRunForParams): Promise<DelegatedWorkflowRunAccepted> {",
    ]);
  });
});

describe("the wire constants agree with the host's", () => {
  test("the SDK sends the method the host admits `runFor` on, and only that one", () => {
    // A source-text pin rather than an import: these are module-private in
    // the SDK on purpose (they are not API an extension author calls), and
    // the value is what has to match, not the binding.
    expect(sdk).toContain(
      `const DELEGATED_WORKFLOWS_METHOD = ${JSON.stringify(DELEGATED_WORKFLOWS_METHOD)};`,
    );
    expect(DELEGATED_WORKFLOWS_METHOD).toBe("ezcorp/workflows-delegated");
  });

  test("the SDK sends the op the host routes on", () => {
    expect(sdk).toContain(`const DELEGATED_OP = ${JSON.stringify(DELEGATED_OP)};`);
    expect(DELEGATED_OP).toBe("runFor");
  });

  test("`DelegatedRunAs` covers exactly the owner kinds the host can write", () => {
    // The SDK cannot import the host's `DelegationOwnerKind` (it is a
    // standalone published package), so the union is a copy — and a copy
    // of a two-armed union is precisely the thing that goes stale when a
    // third principal kind lands. `DELEGATION_OWNER_COLUMN` is the host's
    // keyed lookup over that union, so its key set is the drift oracle.
    const declared = /export type DelegatedRunAs =([^;]+);/.exec(stripComments(sdk))?.[1] ?? "";
    const arms = declared
      .split("|")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    expect(arms.sort()).toEqual(Object.keys(DELEGATION_OWNER_COLUMN).sort());
  });
});

describe("the two jobRef sentences have not drifted apart", () => {
  // Phase 6 wrote one sentence at each of the two `jobRef` sites saying
  // which one grants authority, because a reader who finds one and not the
  // other will assume they mean the same thing. The SDK is the THIRD site
  // and the only one an extension author reads. It quotes both verbatim
  // rather than paraphrasing, and these tests are what keeps the quote
  // honest: reword the handler and this file goes red until the SDK
  // follows.

  /** The `run` op's sentence — the handle is inert there. */
  const INERT = "ON THIS OP THE HANDLE GRANTS NOTHING";
  /** The `runFor` op's sentence — the handle selects the authority there. */
  const AUTHORITY = "here the `jobRef` selects the authority.";

  test("the handler still says both things, once each", () => {
    expect(handler.split("\n").filter((l) => l.includes(INERT))).toHaveLength(1);
    expect(handler.split("\n").filter((l) => l.includes(AUTHORITY))).toHaveLength(1);
  });

  test("the SDK quotes BOTH, so an author reading one op sees the other's rule", () => {
    expect(sdk).toContain(INERT);
    expect(sdk).toContain(AUTHORITY);
  });

  test("the SDK states what the kill switch does, not merely that one exists", () => {
    // An operator-set, instance-wide, transient refusal that touches
    // nothing of the extension's own. An author who read "disabled" and
    // deleted their saved job in response would have destroyed a human's
    // consent record over a flag someone will unset in an hour.
    for (const claim of [
      "EZCORP_DISABLE_DELEGATED_WORKFLOWS=1",
      "refused before ANY database work",
      "the delegation itself is untouched",
      "disable or delete anything of your own in response",
    ]) {
      expect(sdk).toContain(claim);
    }
  });
});
