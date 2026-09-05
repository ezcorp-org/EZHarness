import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getProjectRoot, resolveBundledExtensions, isBundledExtensionName } from "../extensions/bundled";
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";

describe("resolveBundledExtensions — orchestration entry", () => {
  test("includes orchestration by default with no opt-out flag", () => {
    const list = resolveBundledExtensions({});
    expect(list.some((e) => e.name === "orchestration")).toBe(true);
  });

  test("declares the Phase 4 capability set: agentConfig:read + spawnAgents + eventSubscriptions (Phase 5's ask_human dropped in ask-user migration)", () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "orchestration")!;
    expect(entry.path).toBe("docs/extensions/examples/orchestration");
    expect(entry.permissions.agentConfig).toBe("read");
    // Deliberately higher than task-tracking (200/10) — the
    // orchestration extension is the primary fan-out mechanism and
    // routinely dispatches a team of sub-agents per turn.
    expect(entry.permissions.spawnAgents).toEqual({
      maxPerHour: 500,
      maxConcurrent: 25,
    });
    // After the ask-user migration this extension only needs
    // `task:assignment_update` for invoke_agent's two-hop bridge.
    // Human-in-the-loop moved to the bundled `ask-user` extension
    // which subscribes to its own `ask-user:answer` event.
    expect(entry.permissions.eventSubscriptions).toEqual([
      "task:assignment_update",
    ]);
    // No storage — the extension keeps pending invocations in-memory
    // under its `persistent: true` subprocess.
    expect(entry.permissions.storage).toBeUndefined();
    // No taskEvents — orchestration doesn't emit snapshot/update events
    // directly; that's task-tracking's job.
    expect(entry.permissions.taskEvents).toBeUndefined();

    // Every capability has a grantedAt timestamp so the audit writer
    // can emit oldValue/newValue transitions.
    for (const key of ["agentConfig", "spawnAgents", "eventSubscriptions"]) {
      expect(entry.permissions.grantedAt[key]).toBeGreaterThan(0);
    }
  });
});

describe("isBundledExtensionName — orchestration is recognized", () => {
  test("recognizes the reviewed bundled source", () => {
    expect(isBundledExtensionName("orchestration")).toBe(true);
  });
});


test("orchestration actual v4 worker preserves its complete tool catalog and declared capabilities", async () => {
  const manifest = await discoverFirstPartyManifest(join(getProjectRoot(), "docs/extensions/examples/orchestration"));
  expect((manifest.tools ?? []).map((tool) => tool.name).sort()).toEqual(["collect_agent_result","invoke_agent","send_to_agent"]);
  const entry = resolveBundledExtensions({}).find((candidate) => candidate.name === "orchestration")!;
  const { grantedAt, ...capabilities } = entry.permissions;
  expect(manifest.permissions as unknown).toEqual(capabilities);
  expect(manifest.version.startsWith("1.")).toBe(true);
});
