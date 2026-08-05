/**
 * The nested (`kind: "workflow"`) step's resolver.
 *
 * This rule was previously an inline arrow inside `ensureInitialized()` in
 * `web/src/lib/server/context.ts` — boot wiring that no test executes — so
 * an authorization decision lived somewhere it could not be asserted. These
 * are the assertions that became possible when it moved out, and they are
 * the reason it moved.
 */
import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { systemCachedWorkflow, type CachedWorkflow } from "../runtime/workflow-scope";
import type { WorkflowDefinition } from "../types";

/** Every `listProjectIdsForUser` call, so "was the DB touched?" is assertable
 *  rather than inferred from a verdict that could be right by accident. */
let membershipCalls: string[];
let memberships: Record<string, string[]>;

const projectMembersMock = () => ({
  listProjectIdsForUser: async (userId: string) => {
    membershipCalls.push(userId);
    return memberships[userId] ?? [];
  },
});
mock.module("../db/queries/project-members", projectMembersMock);

const { makeNestedWorkflowResolver } = await import("../runtime/nested-workflow-resolver");

afterAll(() => {
  restoreModuleMocks();
});

const definition = (name: string): WorkflowDefinition => ({
  name,
  description: "",
  steps: [{ name: "one", kind: "transform", output: { a: "b" } }],
});

const OWNER = "u-owner";
const PROJECT = "project-a";

function dbEntry(name: string, overrides: Partial<CachedWorkflow> = {}): CachedWorkflow {
  return {
    definition: definition(name),
    source: "db",
    id: `id-${name}`,
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
    ...overrides,
  };
}

const ENTRIES: CachedWorkflow[] = [
  systemCachedWorkflow(definition("shipped"), "yaml"),
  dbEntry("scoped", { visibility: "project", projectId: PROJECT, userId: OWNER }),
  dbEntry("unscoped", { visibility: "project", projectId: null, userId: OWNER }),
  dbEntry("secret", { visibility: "private", projectId: PROJECT, userId: OWNER }),
];

let entries: CachedWorkflow[];
const resolve = makeNestedWorkflowResolver(() => entries);

beforeEach(() => {
  membershipCalls = [];
  memberships = { "u-in": [PROJECT], "u-out": ["project-b"], [OWNER]: [PROJECT] };
  entries = [...ENTRIES];
});

describe("makeNestedWorkflowResolver", () => {
  test("resolves a `system` workflow for any principal, including a userless run", async () => {
    expect((await resolve("shipped", { userId: "u-out" }))!.name).toBe("shipped");
    expect((await resolve("shipped", {}))!.name).toBe("shipped");
  });

  test("an unknown name resolves to undefined", async () => {
    expect(await resolve("no-such-workflow", { userId: "u-in" })).toBeUndefined();
  });

  test("a project-SCOPED workflow resolves for a member of that project", async () => {
    expect((await resolve("scoped", { userId: "u-in" }))!.name).toBe("scoped");
  });

  test("…and NOT for a member of a different project", async () => {
    // The regression this module exists to make assertable. Before the
    // membership model every authenticated principal resolved this.
    expect(await resolve("scoped", { userId: "u-out" })).toBeUndefined();
  });

  test("a project-LESS `project` workflow resolves for any principal with a user", async () => {
    expect((await resolve("unscoped", { userId: "u-out" }))!.name).toBe("unscoped");
  });

  test("a `private` workflow resolves only for its owner", async () => {
    expect((await resolve("secret", { userId: OWNER }))!.name).toBe("secret");
    expect(await resolve("secret", { userId: "u-in" })).toBeUndefined();
  });

  test("`role: \"member\"` is conservative — no run is ever treated as an admin", async () => {
    // A run carries a principal id, not a role, so there is no input that
    // could make this resolver hand over someone else's `private` row. The
    // admin exemption in the ladder is reachable only through a route.
    for (const userId of ["u-in", "u-out", OWNER, "anyone-at-all"]) {
      const verdict = await resolve("secret", { userId });
      expect(verdict === undefined).toBe(userId !== OWNER);
    }
  });

  test("a run with NO principal never queries memberships", async () => {
    // Membership is keyed by user id, so there is nothing to look up — and
    // the ladder refuses a null-userId caller on the project tier before the
    // set would be consulted anyway.
    expect(await resolve("scoped", {})).toBeUndefined();
    expect(await resolve("unscoped", {})).toBeUndefined();
    expect(membershipCalls).toEqual([]);
  });

  test("a run WITH a principal queries once, for that principal's id", async () => {
    await resolve("scoped", { userId: "u-in" });
    expect(membershipCalls).toEqual(["u-in"]);
  });

  test("the caller's `projectId` claim changes nothing", async () => {
    // It comes off the run, not the DB. A resolver that read it would be a
    // boundary the caller controls.
    expect(await resolve("scoped", { userId: "u-out", projectId: PROJECT })).toBeUndefined();
    expect((await resolve("scoped", { userId: "u-in", projectId: "project-zzz" }))!.name).toBe(
      "scoped",
    );
  });

  test("the cache is read through the thunk on EVERY call, never captured", async () => {
    // `reloadWorkflows()` reassigns the binding on every CRUD write. A
    // resolver holding the array by value would keep serving a stale list
    // for the lifetime of the process.
    expect(await resolve("added-later", { userId: "u-in" })).toBeUndefined();
    entries = [...entries, systemCachedWorkflow(definition("added-later"), "yaml")];
    expect((await resolve("added-later", { userId: "u-in" }))!.name).toBe("added-later");
  });
});
