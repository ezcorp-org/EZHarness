// Manifest validity: the file-organizer manifest must pass the host's
// validateManifestV2, declare ≤3 pages, and have every page-action event
// declared in permissions.eventSubscriptions (so the page-tree validator
// won't drop a single action node).
import { describe, expect, test } from "bun:test";
import { validateManifestV2 } from "../../../../src/extensions/manifest";
import manifest from "./ezcorp.config";
import { ALL_EVENTS } from "./lib/page";

describe("file-organizer manifest", () => {
  test("passes validateManifestV2", () => {
    const { valid, errors } = validateManifestV2(manifest as unknown);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  test("declares exactly the 3 Hub pages", () => {
    expect(manifest.pages?.map((p) => p.id)).toEqual(["overview", "review", "folders"]);
    expect((manifest.pages ?? []).length).toBeLessThanOrEqual(3);
  });

  test("eventSubscriptions exactly mirror ALL_EVENTS", () => {
    const subs = manifest.permissions?.eventSubscriptions;
    expect(Array.isArray(subs)).toBe(true);
    expect((subs as string[]).slice().sort()).toEqual(ALL_EVENTS.slice().sort());
  });

  test("no network/shell grant; storage disabled; fs is $CWD only", () => {
    const perms = manifest.permissions!;
    expect((perms as { network?: unknown }).network).toBeUndefined();
    expect(perms.shell).toBe(false);
    expect(perms.storage).toBe(false);
    expect(perms.filesystem).toEqual(["$CWD"]);
  });

  test("declares the persistent host-side daemon entrypoint", () => {
    expect(manifest.entrypoint).toBe("./index.ts");
    expect(manifest.persistent).toBe(true);
  });

  test("settings expose the six scalar knobs with defaults", () => {
    const s = manifest.settings!;
    expect(Object.keys(s).sort()).toEqual(
      ["daemon_enabled", "default_mode", "quarantine_cap_gb", "quarantine_ttl_days", "scan_interval_sec", "stability_ticks"].sort(),
    );
    expect(s.daemon_enabled!.default).toBe(true);
    expect(s.default_mode!.default).toBe("ask-everything");
  });

  test("exposes the seven agent tools", () => {
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "apply_workflow_config",
        "describe_current_workflow",
        "organize_backlog",
        "propose_moves",
        "propose_target_workflow",
        "set_folder_rules",
        "teach_rule",
      ].sort(),
    );
  });
});
