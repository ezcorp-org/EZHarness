/**
 * Per-API-key tool policy — the pure predicates all three boundaries share.
 *
 * The load-bearing properties, and why each is a test rather than a comment:
 *
 *  - **Every `ROUTE_BUNDLES` entry resolves against `src/api-registry.ts`.**
 *    A typo'd bundle entry is not a loud failure; it is a route the operator
 *    believes they granted and the hook silently denies forever. The registry
 *    meta-test already guarantees the registry is exhaustive in both
 *    directions, so this is a check against a CLOSED set.
 *  - **Absent-in-request is WIDENING** in `policyOverCeiling`, per field. A
 *    policied actor that could mint a key with no `routeAllowlist` would have
 *    laundered its own confinement away in one request.
 *  - **`mayUseMode` fails closed on `null`.** `conversations.mode_id` is
 *    `ON DELETE SET NULL`, so "the owner deleted the locked mode" must brick
 *    the key, never free it.
 *  - **No policy ⇒ today's behaviour.** Every predicate has an explicit
 *    unpolicied arm.
 */

import { describe, expect, test } from "bun:test";
import { apiRegistry } from "../api-registry";
import { MAX_CALLER_TOOLS } from "../runtime/caller-tool-declarations";
import {
  CONVERSATION_RUN_START_ROUTES,
  MAX_POLICY_ROUTES,
  MODE_GUARDED_RUN_START_ROUTES,
  ROUTE_BUNDLES,
  TOOL_POLICY_FIELDS,
  mayDeclareCallerTools,
  mayUseMode,
  policyOverCeiling,
  resolveRouteBundle,
  routeBundleNames,
  routeIdToRegistryPath,
  runStartPolicyDenial,
  runStartToolPolicyOptions,
  validateToolPolicy,
  type ToolPolicy,
} from "../auth/tool-policy";

/** A registry context whose mode always resolves — the arm that isolates a
 *  route/name/cap failure from a mode failure. */
const ctxModeOk = {
  getMode: async (id: string) => ({ id }),
  ownerId: "owner-1",
  registry: apiRegistry,
};
/** The fail-closed mode arm: no mode is visible to this owner. */
const ctxModeMissing = {
  getMode: async () => null,
  ownerId: "owner-1",
  registry: apiRegistry,
};

const BUNDLE = ROUTE_BUNDLES["desktop-companion"]!;

describe("route bundles", () => {
  test("every bundle entry resolves to a registered route", () => {
    const known = new Set(apiRegistry.map((e) => `${e.method} ${e.path}`));
    const unresolved: string[] = [];
    for (const [bundle, routes] of Object.entries(ROUTE_BUNDLES)) {
      for (const entry of routes) {
        const space = entry.indexOf(" ");
        const key = `${entry.slice(0, space)} ${routeIdToRegistryPath(entry.slice(space + 1))}`;
        if (!known.has(key)) unresolved.push(`${bundle}: ${entry}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  test("the bundles are non-empty (guards against a vacuous pass above)", () => {
    expect(Object.keys(ROUTE_BUNDLES).length).toBeGreaterThan(0);
    expect(BUNDLE.length).toBe(14);
  });

  test("desktop-companion excludes every HTTP-initiated spawn path", () => {
    // The class of bypass Boundary 1 exists for: routes that start a run with
    // no LLM tool call at all, so no tool-surface filter can ever see them.
    for (const forbidden of [
      "POST /api/workflows/[name]/run",
      "POST /api/agents/[name]/run",
      "POST /api/agent-configs",
      "POST /api/briefing/run-now",
      "POST /api/conversations/[id]/agent-chat",
      "POST /api/ez-actions/[name]",
      "PUT /api/modes/[id]",
    ]) {
      expect(BUNDLE).not.toContain(forbidden);
    }
  });

  test("resolveRouteBundle answers null for an unknown name", () => {
    expect(resolveRouteBundle("desktop-companion")).toEqual(BUNDLE);
    expect(resolveRouteBundle("no-such-bundle")).toBeNull();
  });

  test("routeBundleNames lists the bundles, sorted", () => {
    const names = routeBundleNames();
    expect(names).toContain("desktop-companion");
    expect(names).toEqual([...names].sort());
  });

  test("routeIdToRegistryPath converts both segment kinds", () => {
    expect(routeIdToRegistryPath("/api/conversations/[id]/messages")).toBe(
      "/api/conversations/:id/messages",
    );
    expect(routeIdToRegistryPath("/api/conversations/[id]/messages/[mid]/retry")).toBe(
      "/api/conversations/:id/messages/:mid/retry",
    );
    expect(routeIdToRegistryPath("/api/files/[...path]")).toBe("/api/files/:path");
    expect(routeIdToRegistryPath("/api/tools")).toBe("/api/tools");
  });

  test("every mode-guarded run-start route is a run-start route", () => {
    for (const r of MODE_GUARDED_RUN_START_ROUTES) {
      expect(CONVERSATION_RUN_START_ROUTES).toContain(r);
    }
  });

  test("TOOL_POLICY_FIELDS names every field of ToolPolicy", () => {
    // The ceiling check iterates this list, so a field missing from it is a
    // field a policied actor could widen for free.
    const sample: Required<ToolPolicy> = {
      routeAllowlist: [],
      allowedCallerTools: [],
      maxCallerTools: 1,
      lockedModeId: "m",
    };
    expect(([...TOOL_POLICY_FIELDS] as string[]).sort()).toEqual(Object.keys(sample).sort());
  });
});

describe("validateToolPolicy", () => {
  test("no policy is valid", async () => {
    expect(await validateToolPolicy(undefined, ctxModeOk)).toBeNull();
    expect(await validateToolPolicy(null, ctxModeOk)).toBeNull();
  });

  test("an empty policy is refused (it would mark the key policied and confine nothing)", async () => {
    expect(await validateToolPolicy({}, ctxModeOk)).toEqual([
      "toolPolicy must constrain at least one field",
    ]);
  });

  test("a full, legal policy validates", async () => {
    expect(
      await validateToolPolicy(
        {
          routeAllowlist: [...BUNDLE],
          allowedCallerTools: ["open_app"],
          maxCallerTools: 1,
          lockedModeId: "mode-1",
        },
        ctxModeOk,
      ),
    ).toBeNull();
  });

  describe("routeAllowlist", () => {
    test("must be a non-empty array", async () => {
      expect(await validateToolPolicy({ routeAllowlist: [] }, ctxModeOk)).toEqual([
        "routeAllowlist must be a non-empty array",
      ]);
      expect(
        await validateToolPolicy(
          { routeAllowlist: "GET /api/tools" as unknown as string[] },
          ctxModeOk,
        ),
      ).toEqual(["routeAllowlist must be a non-empty array"]);
    });

    test(`may name at most ${MAX_POLICY_ROUTES} routes`, async () => {
      const tooMany = Array.from({ length: MAX_POLICY_ROUTES + 1 }, (_, i) => `GET /api/x${i}`);
      expect(await validateToolPolicy({ routeAllowlist: tooMany }, ctxModeOk)).toEqual([
        `routeAllowlist may name at most ${MAX_POLICY_ROUTES} routes`,
      ]);
    });

    test("entries must be strings", async () => {
      const errs = await validateToolPolicy(
        { routeAllowlist: [42 as unknown as string] },
        ctxModeOk,
      );
      expect(errs).toEqual(["routeAllowlist entries must be strings"]);
    });

    test("a duplicate entry is reported once", async () => {
      const errs = await validateToolPolicy(
        { routeAllowlist: ["GET /api/tools", "GET /api/tools"] },
        ctxModeOk,
      );
      expect(errs).toEqual(['routeAllowlist names "GET /api/tools" twice']);
    });

    test("the shape must be METHOD /api/…", async () => {
      for (const bad of ["/api/tools", "FETCH /api/tools", "GET /notapi/tools"]) {
        const errs = await validateToolPolicy({ routeAllowlist: [bad] }, ctxModeOk);
        expect(errs?.[0]).toContain(`routeAllowlist entry "${bad}" must be "METHOD /api/…"`);
      }
    });

    test("an unregistered route is a mint-time error, not a silent deny", async () => {
      // The whole reason the check exists: a typo here would otherwise mint a
      // key denied on a route its operator believes they granted.
      const errs = await validateToolPolicy(
        { routeAllowlist: ["GET /api/conversations/[idd]"] },
        ctxModeOk,
      );
      expect(errs).toEqual([
        'routeAllowlist entry "GET /api/conversations/[idd]" is not a registered route',
      ]);
    });
  });

  describe("allowedCallerTools", () => {
    test("must be a non-empty array", async () => {
      expect(await validateToolPolicy({ allowedCallerTools: [] }, ctxModeOk)).toEqual([
        "allowedCallerTools must be a non-empty array",
      ]);
      expect(
        await validateToolPolicy(
          { allowedCallerTools: "open_app" as unknown as string[] },
          ctxModeOk,
        ),
      ).toEqual(["allowedCallerTools must be a non-empty array"]);
    });

    test(`may name at most ${MAX_CALLER_TOOLS} tools`, async () => {
      const many = Array.from({ length: MAX_CALLER_TOOLS + 1 }, (_, i) => `tool_${i}`);
      expect(await validateToolPolicy({ allowedCallerTools: many }, ctxModeOk)).toEqual([
        `allowedCallerTools may name at most ${MAX_CALLER_TOOLS} tools`,
      ]);
    });

    test("names must satisfy the declaration name rule", async () => {
      // Same predicate the PUT …/caller-tools route applies, so a policy can
      // never name a tool no declaration could be spelled as.
      for (const bad of ["Open_App", "ab", "a__b", 7 as unknown as string]) {
        const errs = await validateToolPolicy({ allowedCallerTools: [bad] }, ctxModeOk);
        expect(errs?.[0]).toContain("is not a legal caller-tool name");
      }
    });

    test("a duplicate name is reported", async () => {
      expect(
        await validateToolPolicy({ allowedCallerTools: ["open_app", "open_app"] }, ctxModeOk),
      ).toEqual(['allowedCallerTools names "open_app" twice']);
    });
  });

  describe("maxCallerTools", () => {
    test("accepts 1..MAX", async () => {
      expect(await validateToolPolicy({ maxCallerTools: 1 }, ctxModeOk)).toBeNull();
      expect(await validateToolPolicy({ maxCallerTools: MAX_CALLER_TOOLS }, ctxModeOk)).toBeNull();
    });

    test("refuses 0, MAX+1 and a non-integer", async () => {
      for (const n of [0, MAX_CALLER_TOOLS + 1, 1.5, Number.NaN]) {
        const errs = await validateToolPolicy({ maxCallerTools: n }, ctxModeOk);
        expect(errs?.[0]).toContain(`maxCallerTools must be an integer 1..${MAX_CALLER_TOOLS}`);
      }
    });
  });

  describe("lockedModeId", () => {
    test("must be a non-empty string", async () => {
      expect(await validateToolPolicy({ lockedModeId: "" }, ctxModeOk)).toEqual([
        "lockedModeId must be a non-empty string",
      ]);
      expect(
        await validateToolPolicy({ lockedModeId: 5 as unknown as string }, ctxModeOk),
      ).toEqual(["lockedModeId must be a non-empty string"]);
    });

    test("must resolve to a mode the KEY OWNER can see", async () => {
      expect(await validateToolPolicy({ lockedModeId: "mode-x" }, ctxModeMissing)).toEqual([
        'lockedModeId "mode-x" is not a mode visible to the key owner',
      ]);
    });

    test("the owner id is the one handed to getMode", async () => {
      const seen: string[] = [];
      await validateToolPolicy(
        { lockedModeId: "mode-1" },
        {
          getMode: async (id, ownerId) => {
            seen.push(`${id}:${ownerId}`);
            return { id };
          },
          ownerId: "owner-42",
          registry: apiRegistry,
        },
      );
      expect(seen).toEqual(["mode-1:owner-42"]);
    });

    test("an undefined mode result is treated as missing (fail-closed)", async () => {
      expect(
        await validateToolPolicy(
          { lockedModeId: "mode-x" },
          { getMode: async () => undefined, ownerId: "o", registry: apiRegistry },
        ),
      ).toEqual(['lockedModeId "mode-x" is not a mode visible to the key owner']);
    });

    test("refuses a lock the allowlist can route around", async () => {
      // agent-chat starts a run against the same conversation but does NOT
      // call mayUseMode, so granting it while claiming a mode lock would be a
      // lock with a documented hole. Refused at MINT, not left to the route.
      const errs = await validateToolPolicy(
        {
          lockedModeId: "mode-1",
          routeAllowlist: ["POST /api/conversations/[id]/agent-chat"],
        },
        ctxModeOk,
      );
      expect(errs).toEqual([
        'lockedModeId cannot be enforced on "POST /api/conversations/[id]/agent-chat" — remove it from routeAllowlist',
      ]);
    });

    test("the guarded run-start route is allowed alongside a lock", async () => {
      expect(
        await validateToolPolicy(
          {
            lockedModeId: "mode-1",
            routeAllowlist: ["POST /api/conversations/[id]/messages"],
          },
          ctxModeOk,
        ),
      ).toBeNull();
    });

    test("an unguarded run-start route is fine WITHOUT a lock", async () => {
      expect(
        await validateToolPolicy(
          { routeAllowlist: ["POST /api/conversations/[id]/agent-chat"] },
          ctxModeOk,
        ),
      ).toBeNull();
    });
  });
});

// ── Boundary 3, as streamChat options ──────────────────────────────────
//
// Boundary 3 shipped INERT: both options existed, `setup-tools` threaded
// them, and the only setter was a test injecting them into `streamChat`. This
// derivation is the product's single populator, so its arms are the contract.
describe("runStartToolPolicyOptions", () => {
  test("no policy spreads NOTHING — a cookie session is unchanged", () => {
    // Spread into the streamChat call, so `{}` must mean "every option keeps
    // the value the route would otherwise have passed", not "undefined".
    expect(runStartToolPolicyOptions(undefined)).toEqual({});
    expect(runStartToolPolicyOptions(null)).toEqual({});
    expect(Object.keys(runStartToolPolicyOptions(undefined))).toEqual([]);
  });

  test("ANY policy denies the spawn surface", () => {
    // Boundaries 1 and 3 are two halves of one confinement: the route
    // allowlist cannot see a mid-turn `invoke_agent`, because it issues no
    // HTTP request. A key confined on ANY axis is a leaf credential.
    for (const policy of [
      { routeAllowlist: ["GET /api/tools"] },
      { lockedModeId: "mode-1" },
      { maxCallerTools: 1 },
      { allowedCallerTools: ["open_app"] },
    ] satisfies ToolPolicy[]) {
      expect(runStartToolPolicyOptions(policy).forceDenyOrchestration).toBe(true);
    }
  });

  test("allowedCallerTools becomes the run's caller-tool cap", () => {
    expect(runStartToolPolicyOptions({ allowedCallerTools: ["open_app"] })).toEqual({
      callerToolAllowlist: ["open_app"],
      forceDenyOrchestration: true,
    });
  });

  test("an EMPTY allowedCallerTools is carried through as empty, not dropped", () => {
    // `applyCallerToolAllowlist` reads nullish as "no constraint" and empty as
    // "no caller tools". Dropping the empty array would invert the policy at
    // exactly the value an operator uses to lock a key down hardest.
    expect(runStartToolPolicyOptions({ allowedCallerTools: [] })).toEqual({
      callerToolAllowlist: [],
      forceDenyOrchestration: true,
    });
  });

  test("a policy with no allowedCallerTools OMITS the key entirely", () => {
    // Not `undefined` — the object is SPREAD into streamChat's options, and
    // `callerToolAllowlist: undefined` would still be an own property. It
    // reads the same to `applyCallerToolAllowlist`, but the absent form is
    // what makes "spreads nothing" checkable.
    const opts = runStartToolPolicyOptions({ lockedModeId: "mode-1" });
    expect(Object.keys(opts)).toEqual(["forceDenyOrchestration"]);
  });

  test("the returned allowlist is a COPY — a route cannot mutate the key's policy", () => {
    const policy: ToolPolicy = { allowedCallerTools: ["open_app"] };
    const opts = runStartToolPolicyOptions(policy);
    opts.callerToolAllowlist?.push("smuggled");
    expect(policy.allowedCallerTools).toEqual(["open_app"]);
  });
});

describe("policyOverCeiling — absent-in-request is WIDENING", () => {
  const actor: Required<ToolPolicy> = {
    routeAllowlist: ["GET /api/tools", "GET /api/modes"],
    allowedCallerTools: ["open_app", "close_app"],
    maxCallerTools: 4,
    lockedModeId: "mode-1",
  };

  test("an UNPOLICIED actor may mint anything (the common case)", () => {
    expect(policyOverCeiling(undefined, actor)).toEqual([]);
    expect(policyOverCeiling(null, undefined)).toEqual([]);
  });

  test("a policied actor can NEVER mint an unpolicied key", () => {
    const allFields = [...TOOL_POLICY_FIELDS].sort() as string[];
    expect(policyOverCeiling(actor, undefined).sort()).toEqual(allFields);
    expect(policyOverCeiling(actor, {}).sort()).toEqual(allFields);
  });

  test("an identical policy is within ceiling", () => {
    expect(policyOverCeiling(actor, { ...actor })).toEqual([]);
  });

  test("a strictly narrower policy is within ceiling", () => {
    expect(
      policyOverCeiling(actor, {
        routeAllowlist: ["GET /api/tools"],
        allowedCallerTools: ["open_app"],
        maxCallerTools: 1,
        lockedModeId: "mode-1",
      }),
    ).toEqual([]);
  });

  test("per field: absent is widening", () => {
    for (const field of TOOL_POLICY_FIELDS) {
      const req: ToolPolicy = { ...actor };
      delete req[field];
      expect(policyOverCeiling(actor, req)).toEqual([field]);
    }
  });

  test("per field: a wider value is widening", () => {
    expect(
      policyOverCeiling(actor, { ...actor, routeAllowlist: [...actor.routeAllowlist, "GET /api/runs/[id]"] }),
    ).toEqual(["routeAllowlist"]);
    expect(
      policyOverCeiling(actor, { ...actor, allowedCallerTools: ["open_app", "reveal_file"] }),
    ).toEqual(["allowedCallerTools"]);
    expect(policyOverCeiling(actor, { ...actor, maxCallerTools: 5 })).toEqual(["maxCallerTools"]);
    // A DIFFERENT mode is not narrower — it is a confinement the actor was
    // never granted.
    expect(policyOverCeiling(actor, { ...actor, lockedModeId: "mode-2" })).toEqual([
      "lockedModeId",
    ]);
  });

  test("a field the actor does not constrain is free", () => {
    expect(policyOverCeiling({ maxCallerTools: 2 }, { routeAllowlist: ["GET /api/tools"], maxCallerTools: 1 })).toEqual([]);
  });
});

describe("mayUseMode — fail-closed on null", () => {
  test("no policy / no lock ⇒ unconstrained", () => {
    expect(mayUseMode(undefined, null)).toBe(true);
    expect(mayUseMode(null, "anything")).toBe(true);
    expect(mayUseMode({ maxCallerTools: 1 }, null)).toBe(true);
  });

  test("a deleted locked mode BRICKS the key rather than freeing it", () => {
    expect(mayUseMode({ lockedModeId: "mode-1" }, null)).toBe(false);
  });

  test("only the locked mode passes", () => {
    expect(mayUseMode({ lockedModeId: "mode-1" }, "mode-1")).toBe(true);
    expect(mayUseMode({ lockedModeId: "mode-1" }, "mode-2")).toBe(false);
  });
});

describe("runStartPolicyDenial", () => {
  const locked: ToolPolicy = { lockedModeId: "mode-1" };
  const noGoal = { modeId: "mode-1", metadata: null };

  test("an unpolicied principal is never refused", () => {
    expect(
      runStartPolicyDenial(undefined, { modeId: null, metadata: { goal: { condition: "x" } } }, {
        isGoalCommand: true,
      }),
    ).toBeNull();
  });

  test("in-policy send passes", () => {
    expect(runStartPolicyDenial(locked, noGoal, { isGoalCommand: false })).toBeNull();
    expect(
      runStartPolicyDenial(locked, { modeId: "mode-1", metadata: { spawnDepth: 1 } }, { isGoalCommand: false }),
    ).toBeNull();
    expect(
      runStartPolicyDenial(locked, { modeId: "mode-1" }, { isGoalCommand: false }),
    ).toBeNull();
  });

  test("wrong mode and null mode both refuse, with distinct messages", () => {
    expect(runStartPolicyDenial(locked, { modeId: "mode-2", metadata: null }, { isGoalCommand: false })).toEqual({
      field: "lockedModeId",
      message: "This key is locked to a different mode",
    });
    expect(runStartPolicyDenial(locked, { modeId: null, metadata: null }, { isGoalCommand: false })).toEqual({
      field: "lockedModeId",
      message: "This key is locked to a mode; the conversation has none",
    });
  });

  test("arming autopilot is refused for ANY policied key", () => {
    expect(runStartPolicyDenial({ maxCallerTools: 1 }, { modeId: null }, { isGoalCommand: true })).toEqual({
      field: "goal",
      message: "This key may not arm autopilot",
    });
  });

  test("a send to an already-armed conversation is refused (drive AND resume)", () => {
    expect(
      runStartPolicyDenial(
        { maxCallerTools: 1 },
        { modeId: null, metadata: { goal: { condition: "ship it", lastReason: null, createdAt: "" } } },
        { isGoalCommand: false },
      ),
    ).toEqual({
      field: "goal",
      message: "This key may not send to a conversation with an armed goal",
    });
  });

  test("a null-valued goal key is not armed", () => {
    expect(
      runStartPolicyDenial({ maxCallerTools: 1 }, { modeId: null, metadata: { goal: null } }, { isGoalCommand: false }),
    ).toBeNull();
  });
});

describe("mayDeclareCallerTools", () => {
  test("no policy ⇒ anything declarable", () => {
    expect(mayDeclareCallerTools(undefined, ["open_app", "reveal_file"])).toEqual({ ok: true });
  });

  test("the count cap refuses with no single offender", () => {
    expect(mayDeclareCallerTools({ maxCallerTools: 1 }, ["a_tool", "b_tool"])).toEqual({
      ok: false,
      field: "maxCallerTools",
    });
    expect(mayDeclareCallerTools({ maxCallerTools: 2 }, ["a_tool", "b_tool"])).toEqual({ ok: true });
  });

  test("the name cap names the offender", () => {
    expect(
      mayDeclareCallerTools({ allowedCallerTools: ["open_app"] }, ["open_app", "capture_screen"]),
    ).toEqual({ ok: false, field: "allowedCallerTools", offender: "capture_screen" });
    expect(mayDeclareCallerTools({ allowedCallerTools: ["open_app"] }, ["open_app"])).toEqual({
      ok: true,
    });
  });

  test("a policy that constrains neither cap allows any declaration", () => {
    expect(mayDeclareCallerTools({ lockedModeId: "m" }, ["anything_here"])).toEqual({ ok: true });
  });
});
