/**
 * The ez-factory manifest's DECLARED SURFACE, asserted exactly.
 *
 * Every permission below was argued for or against by reading the host
 * code, and two of them were removed after that reading showed they buy
 * nothing (`llm`) or have no consumer (`shell`, `network`, `settings`,
 * `secrets`). Absence is the design, and absence is invisible in a diff —
 * a future author "restoring" one would widen the grant with nothing
 * failing.
 *
 * `workflows.allowDelegated` was a THIRD removal and is back at phase 9,
 * because the reasoning that removed it was wrong in a way only a real
 * background fire exposes: `ctx.workflows.run()` refuses an ownerless
 * call at rung 7, so the flag is not a widening this extension does not
 * use — it is the ONLY route it has to act on the `triggers` grant it
 * already holds. Same shape of mistake as the 8.1 `eventSubscriptions`
 * drop below: a capability declined on a reading that never ran the path.
 *
 * `eventSubscriptions` was a FOURTH removal at 8.1 and is back at 8.6,
 * narrowed to what it is actually for. The 8.1 reasoning — a `workflow:*`
 * event can never reach an extension — is correct and still asserted
 * below; it just does not apply to the other thing this one manifest key
 * declares, Hub PAGE ACTIONS, which reach the extension by a different
 * path entirely. Dropping the key whole cost the console its only control:
 * `validatePageTree` deletes an action whose event is not granted, so the
 * job editor rendered without its Save and nothing failed.
 *
 * So this file pins the EXACT key set rather than spot-checking presence:
 * add a key and `permission keys are EXACTLY the six declared` fails; add
 * a page and `declares exactly two pages` fails.
 *
 * Companion coverage:
 *   - `src/__tests__/ez-factory-bundled-install.test.ts` — the ceiling
 *     row, the three-way `webhookPrefix` byte-match, and the boot proof
 *     that the trigger grant survives `intersectPermissions`.
 *   - `src/__tests__/ez-factory-agents-bundled-wiring.test.ts` — the
 *     agent seeder this manifest's registration activates.
 */
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@ezcorp/sdk";

import config from "./ezcorp.config";
import { JOB_RUN_EVENT, JOB_SAVE_EVENT, PAGE_EVENTS } from "./lib/page";

/** The manifest's permission block, read as a bag so absence assertions
 *  can name keys the type does not declare (`allowDelegated`). */
const perms = config.permissions as unknown as Record<string, unknown>;

describe("ez-factory manifest — identity", () => {
  test("is a v2 manifest named ez-factory", () => {
    expect(config.schemaVersion).toBe(4);
    expect(config.name).toBe("ez-factory");
    expect(config.version).toBe("0.1.0");
  });

  test("declares the three tools and the entrypoint they require (8.4)", () => {
    // `validateManifestV2` requires an entrypoint whenever tools are
    // declared, and `bundled-manifests-installable.test.ts` asserts the
    // pairing across the whole bundled list — plus that the entrypoint
    // FILE exists, since the install path checksums it. Declaring tools
    // without it fails the bundled install closed at boot.
    expect(config.entrypoint).toBe("./extension.ts");
    expect(config.tools?.map((t) => t.name)).toEqual([
      "read_files",
      "write_file",
      "emit_artifact",
    ]);
  });

  test("no tool declares an rbacScope", () => {
    // `ToolExecutor.executeToolCall` resolves a declared tool scope
    // against a project DERIVED FROM THE CONVERSATION, and a workflow
    // tool step runs under the synthetic key `workflow-run:<uuid>` — a
    // conversation row that does not exist and therefore has no project.
    // A scope here would deny every call made from the only place these
    // tools are called from. Asserted here AND in
    // `lib/tools/index.test.ts`, because absence is invisible in a diff.
    // Typed as the DECLARED manifest shape: `defineExtension` returns `T`
    // exactly, so the optional-and-absent `rbacScope` is not on the config
    // literal's inferred type and this assertion would not compile.
    const tools: ToolDefinition[] = config.tools ?? [];
    for (const tool of tools) {
      expect(tool.rbacScope).toBeUndefined();
    }
  });

  test("run_command and http_fetch stay CUT", () => {
    const names = (config.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("http_fetch");
  });
});

describe("ez-factory manifest — the exact permission key set", () => {
  test("permission keys are EXACTLY the six declared", () => {
    // Adding a seventh is the regression this test exists for. If a key
    // genuinely belongs here, change this list DELIBERATELY and say why
    // in the commit — do not widen it to make a red test green.
    //
    // `eventSubscriptions` was added at 8.6, deliberately: it is what makes
    // the console's Save button exist. Without it `hub-render-pull.ts`
    // computes `allowedEvents: []` and `validatePageTree` DELETES the job
    // editor's form node from the tree — a page that renders, looks
    // finished, and cannot be written to. 8.1 dropped the key on the
    // strength of the `workflow:*` reasoning below, which is correct about
    // platform events and does not apply to Hub page actions.
    expect(Object.keys(perms).sort()).toEqual([
      "eventSubscriptions",
      "filesystem",
      "rbacScopes",
      "storage",
      "triggers",
      "workflows",
    ].sort());
  });

  test("storage is granted", () => {
    expect(perms.storage).toBe(true);
  });

  test("triggers declares all four fields with the factory- namespace", () => {
    // All four matter: the GRANTED shape requires every one of them
    // because `intersectPermissions` does `Math.min` over the numerics,
    // and `webhookPrefix` is a namespace claim the ceiling must repeat.
    expect(perms.triggers).toEqual({
      maxCron: 25,
      maxWebhooks: 25,
      webhookPrefix: "factory-",
      maxRunsPerDay: 500,
    });
  });

  test("workflows names exactly the three shipped templates, with a rate bound", () => {
    expect(perms.workflows).toEqual({
      names: ["docs-factory", "etl-factory", "draft-and-verify"],
      maxRunsPerHour: 60,
      allowDelegated: true,
    });
  });

  test("workflows DOES carry allowDelegated — it is the only route to a background fire", () => {
    // Phase 9 flipped this from absent to `true`, and the flip is the
    // whole point of the phase. The old rationale said the flag bought
    // "nothing it uses"; that was false. This extension declares
    // `triggers` (cron + webhook), a trigger fire is ownerless, and
    // `ctx.workflows.run()` is refused for an ownerless call at rung 7
    // (`WORKFLOWS_NO_OWNER`, -32106) — deliberately. `runFor`, gated on
    // this boolean, is the one sanctioned path from a cron tick to a run,
    // so declining the flag did not narrow the extension: it left
    // `permissions.triggers` unactionable.
    //
    // Asserted as an EXACT key set, so a future author who deletes the
    // flag fails a named test rather than silently un-firing every
    // unattended job (the failure direction is silent: a dropped
    // `allowDelegated` refuses `runFor` and logs nothing on the job).
    const workflows = perms.workflows as Record<string, unknown>;
    expect(workflows.allowDelegated).toBe(true);
    expect(Object.keys(workflows).sort()).toEqual(
      ["allowDelegated", "maxRunsPerHour", "names"],
    );
  });

  test("filesystem is $CWD only — never $USER", () => {
    // `$USER` collapses to `UNRESOLVED_USER_PREFIX` (a NUL-bearing
    // sentinel that matches no path) when there is no acting user to
    // partition by. Workflow tool steps run under a synthetic
    // `workflow-run:<uuid>` key with none, so a `$USER` grant would
    // fail-closed on every write inside a workflow.
    expect(perms.filesystem).toEqual(["$CWD"]);
    for (const prefix of perms.filesystem as string[]) {
      expect(prefix).not.toContain("$USER");
    }
  });

  test("declares exactly the three console RBAC scopes", () => {
    expect(perms.rbacScopes).toEqual([
      { name: "manage-jobs", description: "Create, edit, enable/disable, and delete factory jobs" },
      { name: "run-job", description: "Fire a factory job manually" },
      { name: "approve-gate", description: "Answer a parked approval step on a factory run" },
    ]);
  });
});

describe("ez-factory manifest — the capabilities deliberately NOT requested", () => {
  // One test per removed capability, each naming the reason, so a failure
  // message tells the next author what reading produced the decision.

  test("no `llm` — it does not bound workflow agent-step spend", () => {
    // `permissions.llm` gates the `ctx.llm.complete()` reverse-RPC only.
    // Workflow agent steps go `AgentExecutor.runAgent` →
    // `createPiLlmAdapter`, which resolves host credentials directly and
    // never consults the extension grant. This extension never calls
    // `ctx.llm`, so an `llm` block would be an unused capability
    // masquerading as a spend bound.
    expect(perms.llm).toBeUndefined();
  });

  test("no PLATFORM event subscription — a workflow:* event can never reach an extension", () => {
    // `EventSubscriptionDispatcher.dispatch` returns early on any payload
    // with no top-level string `conversationId`; `WorkflowRun` has none.
    // The `workflow:*` names ARE in `DIRECT_CARRIER_EVENT_TYPES`, so
    // registration is ACCEPTED and then never fires — registered, silent,
    // forever. Declaring one would be a promise the host cannot keep.
    //
    // The field itself is NOT empty (see below) — it carries Hub page
    // actions, which take an entirely different delivery path. The rule is
    // "no platform event", not "no eventSubscriptions", and this asserts
    // the rule rather than the 8.1 over-correction.
    const subs = perms.eventSubscriptions as string[];
    for (const name of subs) {
      expect(name.startsWith("workflow:")).toBe(false);
      expect(name.startsWith("run:")).toBe(false);
      expect(name.startsWith("task:")).toBe(false);
    }
  });

  test("every declared event is an OWN-NAMESPACE hub page action", () => {
    // `EventSubscriptionDispatcher.registerExtension` branch 2 skips any
    // name whose namespace is not the extension's own, so a cross-namespace
    // subscription is inexpressible rather than merely denied. Declaring one
    // anyway would register nothing and fail silently at click time.
    const subs = perms.eventSubscriptions as string[];
    // Vacuous-pass guard: an empty list would satisfy the loop above AND the
    // loop below while leaving the console unwritable. It is the empty case
    // that is the bug, so assert against it first.
    expect(subs.length).toBeGreaterThan(0);
    for (const name of subs) {
      expect(name.startsWith(`${config.name}:`)).toBe(true);
    }
  });

  test("the declared events are exactly the actions the pages dispatch", () => {
    // One list, two files: the manifest declares what the host will deliver,
    // `lib/page.ts` decides what the tree asks for. A name in one and not the
    // other is a control that either cannot fire or is granted for nothing.
    //
    // Compared against `PAGE_EVENTS` rather than a literal, so adding a
    // third action to `page.ts` fails HERE — pointing at the manifest that
    // needs the name — instead of shipping a button `validatePageTree`
    // silently deletes from the tree.
    expect(perms.eventSubscriptions).toEqual([...PAGE_EVENTS]);
    // Not vacuous: both names are real and distinct, so an accidental
    // `PAGE_EVENTS = []` cannot make the assertion above pass.
    expect(PAGE_EVENTS).toContain(JOB_SAVE_EVENT);
    expect(PAGE_EVENTS).toContain(JOB_RUN_EVENT);
    expect(JOB_SAVE_EVENT).not.toBe(JOB_RUN_EVENT);
  });

  test("no `shell` — run_command was cut from the tool list", () => {
    expect(perms.shell).toBeUndefined();
  });

  test("no `network` — http_fetch was cut from the tool list", () => {
    expect(perms.network).toBeUndefined();
  });

  test("no `settings` and no `secrets`", () => {
    expect(perms.settings).toBeUndefined();
    expect(perms.secrets).toBeUndefined();
  });

  test("no `env`, `schedule`, `webhooks`, `spawnAgents`, `memory`, `lessons`, `search`, `custom`", () => {
    // The remainder of the permission vocabulary, pinned so the
    // exact-key-set test above is not the only thing standing between a
    // careless edit and a wider grant.
    for (const key of [
      "env",
      "schedule",
      "webhooks",
      "spawnAgents",
      "memory",
      "lessons",
      "search",
      "custom",
      "agentConfig",
      "taskEvents",
      "loopEvents",
      "appendMessages",
      "acceptsCallerCaps",
      "escalateChildCaps",
    ]) {
      expect(perms[key]).toBeUndefined();
    }
  });
});

describe("ez-factory manifest — pages", () => {
  test("declares exactly two pages: factory and job", () => {
    // Two of the three-page Hub budget. The third slot is deliberately
    // left free; the approvals inbox is NOT a page (it is per-acting-user
    // while the page cache is shared across viewers) — the console links
    // to core's `/workflows/approvals` instead.
    expect(config.pages).toBeDefined();
    expect(config.pages).toHaveLength(2);
    expect(config.pages?.map((p) => p.id)).toEqual(["factory", "job"]);
  });

  test("every page carries the title the Hub tab needs", () => {
    for (const page of config.pages ?? []) {
      expect(typeof page.title).toBe("string");
      expect(page.title.length).toBeGreaterThan(0);
    }
  });
});
