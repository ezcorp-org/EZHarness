import { test, expect, describe } from "bun:test";
import manifest from "./ezcorp.config";
import { SWEEP_CRON } from "./lib/sweep";
import { validateManifestV2 } from "../../../../src/extensions/manifest";

describe("ez-code-factory manifest", () => {
  test("declares the identity + entrypoint", () => {
    expect(manifest.name).toBe("ez-code-factory");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("exposes the init_gate + code_factory_doctor tools", () => {
    const names = (manifest.tools ?? []).map((t) => t.name);
    expect(names).toContain("init_gate");
    // M6: the read-only diagnostics tool.
    expect(names).toContain("code_factory_doctor");
  });

  test("M6: gates the respond tool behind the `respond-gate` RBAC scope", () => {
    const respond = (manifest.tools ?? []).find((t) => t.name === "code_factory_respond");
    // Host enforcement — the tool is denied pre-dispatch without the scope.
    expect((respond as { rbacScope?: string }).rbacScope).toBe("respond-gate");
  });

  test("M6: declares the two triage RBAC scopes (respond-gate + yolo)", () => {
    const scopes = (manifest.permissions?.rbacScopes ?? []).map((s) => s.name).sort();
    expect(scopes).toEqual(["respond-gate", "yolo"]);
    // Every declared scope carries a non-empty description (the grant-UI text).
    for (const s of manifest.permissions?.rbacScopes ?? []) {
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  test("M6: declares the reconcile-sweep cron matching SWEEP_CRON", () => {
    const schedule = manifest.permissions?.schedule;
    expect(schedule?.crons).toEqual([SWEEP_CRON]);
    expect((schedule?.maxRunsPerDay ?? 0)).toBeGreaterThan(0);
    expect((schedule?.purpose ?? "").length).toBeGreaterThan(0);
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

  test("subscribes to the gate events + the spawn terminal-update carrier", () => {
    expect(manifest.permissions?.eventSubscriptions).toEqual([
      "ez-code-factory:push-received",
      "ez-code-factory:respond",
      "ez-code-factory:yolo",
      "ez-code-factory:reconcile",
      // Direct-carrier platform event — the spawn dispatcher's resolver is
      // dead without it (every agent dispatch times out at 10 minutes).
      "task:assignment_update",
    ]);
  });

  test("declares settings with keys matching resolvePipelineConfig + the secret token", () => {
    const settings = manifest.settings ?? {};
    // Executing knobs must be exactly what lib/config.ts resolvePipelineConfig
    // reads (no dead knob), plus the M4 CI timeout + the encrypted GitHub token.
    // Keys are snake_case — the manifest's SETTINGS_KEY_REGEX rejects camelCase.
    expect(Object.keys(settings).sort()).toEqual([
      "autofix_cap",
      "ci_timeout_hours",
      "default_branch",
      "gate_remote",
      "github_token",
      "ignore_patterns",
      "review_autofix_cap",
    ]);
    expect((settings.review_autofix_cap as { default: number }).default).toBe(0);
    // The token is a write-only secret stored under the gh-runner's key (the
    // storageKey stays "github-token" — a Storage target, not a settings key).
    expect((settings.github_token as { type: string }).type).toBe("secret");
    expect((settings.github_token as { storageKey: string }).storageKey).toBe("github-token");
  });

  // Regression guard (M6 ship-blocker): the manifest MUST pass the host's
  // schema-v2 validator — a camelCase settings key fails SETTINGS_KEY_REGEX
  // (/^[a-z][a-z0-9_]{0,63}$/), which makes loader.ts / sdk/verify.ts /
  // marketplace-import refuse to install the extension. Assert valid + 0 errors
  // so a future camelCase key can never silently ship a non-installable manifest.
  test("passes validateManifestV2 (no camelCase settings key regression)", () => {
    const result = validateManifestV2(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
