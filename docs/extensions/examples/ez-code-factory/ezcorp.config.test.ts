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

  test("code_factory_respond declares the addedFindings input (array of finding objects)", () => {
    const respond = (manifest.tools ?? []).find((t) => t.name === "code_factory_respond");
    const props = (respond?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    // The handler forwards args.addedFindings to parseRespondPayload — it must be
    // a discoverable, typed input, not an undocumented backdoor field.
    const added = props.addedFindings as { type?: string; items?: { type?: string } } | undefined;
    expect(added?.type).toBe("array");
    expect(added?.items?.type).toBe("object");
  });

  test("declares the dashboard page", () => {
    const ids = (manifest.pages ?? []).map((p) => p.id);
    expect(ids).toEqual(["dashboard"]);
  });

  test("requests narrow grants: storage + shell + spawnAgents + $CWD fs + api.github.com", () => {
    const perms = manifest.permissions ?? {};
    expect(perms.storage).toBe(true);
    expect(perms.shell).toBe(true);
    expect(perms.filesystem).toEqual(["$CWD"]);
    // spawnAgents: the M1 pipeline drives native sub-agents (decision #2).
    expect(perms.spawnAgents).toBeDefined();
    // M4: `gh` reaches the GitHub API — narrow allowlist, github.com only.
    expect(perms.network).toEqual(["api.github.com"]);
  });

  test("subscribes to the push-received + respond + yolo + reconcile gate events", () => {
    expect(manifest.permissions?.eventSubscriptions).toEqual([
      "ez-code-factory:push-received",
      "ez-code-factory:respond",
      "ez-code-factory:yolo",
      "ez-code-factory:reconcile",
    ]);
  });

  test("declares settings with keys matching resolvePipelineConfig + the secret token", () => {
    const settings = manifest.settings ?? {};
    // Executing knobs must be exactly what lib/config.ts resolvePipelineConfig
    // reads (no dead knob), plus the M4 CI timeout + the encrypted GitHub token.
    expect(Object.keys(settings).sort()).toEqual([
      "autofixCap",
      "ciTimeoutHours",
      "defaultBranch",
      "gateRemote",
      "githubToken",
      "ignorePatterns",
      "reviewAutofixCap",
    ]);
    expect((settings.reviewAutofixCap as { default: number }).default).toBe(0);
    // The token is a write-only secret stored under the gh-runner's key.
    expect((settings.githubToken as { type: string }).type).toBe("secret");
    expect((settings.githubToken as { storageKey: string }).storageKey).toBe("github-token");
  });
});
