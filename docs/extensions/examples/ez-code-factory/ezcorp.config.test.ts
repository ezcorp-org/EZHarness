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

  test("requests the narrowest grants: storage + shell + $CWD fs, no network", () => {
    const perms = manifest.permissions ?? {};
    expect(perms.storage).toBe(true);
    expect(perms.shell).toBe(true);
    expect(perms.filesystem).toEqual(["$CWD"]);
    // No network grant — the post-receive hook (not the subprocess) calls back.
    expect("network" in perms).toBe(false);
  });

  test("subscribes to the push-received event that gates the hub action", () => {
    expect(manifest.permissions?.eventSubscriptions).toEqual(["ez-code-factory:push-received"]);
  });
});
