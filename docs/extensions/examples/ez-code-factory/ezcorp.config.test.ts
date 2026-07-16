import { test, expect, describe } from "bun:test";
import manifest from "./ezcorp.config";

describe("ez-code-factory manifest", () => {
  test("declares the identity + entrypoint", () => {
    expect(manifest.name).toBe("ez-code-factory");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("exposes the init_gate tool", () => {
    const names = (manifest.tools ?? []).map((t) => t.name);
    expect(names).toContain("init_gate");
  });

  test("declares the dashboard page", () => {
    const ids = (manifest.pages ?? []).map((p) => p.id);
    expect(ids).toEqual(["dashboard"]);
  });

  test("requests the narrowest grants: storage + shell + spawnAgents + $CWD fs, no network", () => {
    const perms = manifest.permissions ?? {};
    expect(perms.storage).toBe(true);
    expect(perms.shell).toBe(true);
    expect(perms.filesystem).toEqual(["$CWD"]);
    // spawnAgents: the M1 pipeline drives native sub-agents (decision #2).
    expect(perms.spawnAgents).toBeDefined();
    // No network grant — the post-receive hook (not the subprocess) calls back.
    expect("network" in perms).toBe(false);
  });

  test("subscribes to the push-received + respond + yolo gate events", () => {
    expect(manifest.permissions?.eventSubscriptions).toEqual([
      "ez-code-factory:push-received",
      "ez-code-factory:respond",
      "ez-code-factory:yolo",
    ]);
  });

  test("declares settings v0 with keys matching resolvePipelineConfig's consumed shape", () => {
    const settings = manifest.settings ?? {};
    // Keys must be exactly what lib/config.ts resolvePipelineConfig reads, so no
    // knob is silently dead (M1 fix item 5).
    expect(Object.keys(settings).sort()).toEqual([
      "autofixCap",
      "defaultBranch",
      "gateRemote",
      "ignorePatterns",
      "reviewAutofixCap",
    ]);
    expect((settings.reviewAutofixCap as { default: number }).default).toBe(0);
  });
});
