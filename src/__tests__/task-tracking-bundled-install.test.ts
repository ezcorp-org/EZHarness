import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getProjectRoot, resolveBundledExtensions, isBundledExtensionName } from "../extensions/bundled";
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";

describe("resolveBundledExtensions — task-tracking entry", () => {
  test("includes task-tracking by default with no opt-out flag", () => {
    const list = resolveBundledExtensions({});
    expect(list.some((e) => e.name === "task-tracking")).toBe(true);
  });

  test("task-tracking cannot be disabled via any env flag (security-by-default)", () => {
    const attempts: Record<string, string>[] = [
      { EZCORP_DISABLE_TASK_TRACKING: "1" },
      { EZCORP_NO_BUNDLED: "1" },
    ];
    for (const env of attempts) {
      const list = resolveBundledExtensions(env);
      expect(list.some((e) => e.name === "task-tracking")).toBe(true);
    }
  });

  test("declares storage + taskEvents + agentConfig + spawnAgents + eventSubscriptions — the full Phase 2 capability set", () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "task-tracking")!;
    expect(entry.path).toBe("docs/extensions/examples/task-tracking");
    expect(entry.permissions.storage).toBe(true);
    expect(entry.permissions.taskEvents).toBe(true);
    expect(entry.permissions.agentConfig).toBe("read");
    expect(entry.permissions.spawnAgents).toEqual({ maxPerHour: 200, maxConcurrent: 10 });
    expect(entry.permissions.eventSubscriptions).toEqual(["task:assignment_update"]);
    // grantedAt timestamps present for every permission so the audit
    // path can write oldValue/newValue deltas.
    for (const key of ["storage", "taskEvents", "agentConfig", "spawnAgents", "eventSubscriptions"]) {
      expect(entry.permissions.grantedAt[key]).toBeGreaterThan(0);
    }
  });
});

describe("isBundledExtensionName — task-tracking is recognized", () => {
  test("recognizes the reviewed task-tracking source", () => {
    expect(isBundledExtensionName("task-tracking")).toBe(true);
  });
});


test("task-tracking actual v4 worker preserves its complete tool catalog and declared capabilities", async () => {
  const manifest = await discoverFirstPartyManifest(join(getProjectRoot(), "docs/extensions/examples/task-tracking"));
  expect((manifest.tools ?? []).map((tool) => tool.name).sort()).toEqual(["task_add","task_assign","task_complete","task_fail","task_list","task_list_agents","task_plan","task_resume","task_set_dependencies","task_start","task_stop","task_subtask_toggle","task_unassign","task_update"]);
  const entry = resolveBundledExtensions({}).find((candidate) => candidate.name === "task-tracking")!;
  const { grantedAt, ...capabilities } = entry.permissions;
  expect(manifest.permissions as unknown).toEqual(capabilities);
  expect(manifest.version.startsWith("1.")).toBe(true);
});
