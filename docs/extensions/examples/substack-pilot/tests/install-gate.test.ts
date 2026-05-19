// ── Install-gate verification ───────────────────────────────────
//
// Proves the env-leak install fix actually works by running the real host
// gate (`checkEnvKeyLeakInstallGate` from src/extensions/clamp-permissions.ts)
// against our manifest. The fix was: drop `permissions.env` entirely — the
// SUBSTACK_* credentials live in `settings`, not host process env, so the
// install gate has nothing to flag.
//
// Why this matters: a future "helpful" PR could try to re-add an env
// grant for ergonomics ("just expose the token via process.env"). The
// install gate would block install for non-bundled extensions like this
// one (SUBSTACK_SESSION_TOKEN matches `_TOKEN$` in ENV_KEY_LEAK_PATTERN),
// but the bug would only surface at install time. These tests catch it
// at unit-test time instead.
//
// We also derive the per-tool capability declarations via the host's
// `deriveCapsFromExtensionPerms` translator to assert what the runtime
// PDP will see when this manifest is loaded — the shell + network + storage
// declarations must survive translation to the v3 capability shape.

import { test, expect, describe } from "bun:test";
import manifest from "../ezcorp.config";
import {
  checkEnvKeyLeakInstallGate,
  EnvKeyLeakInstallError,
  detectEnvKeyLeaks,
} from "../../../../../src/extensions/clamp-permissions";
import {
  deriveCapsFromExtensionPerms,
  migrateManifestV2ToV3,
  validateSettingsSchema,
} from "../../../../../src/extensions/manifest";

describe("substack-pilot — env-leak install gate", () => {
  test("manifest passes env-leak install gate (isBundled=false, envEscapeHatch=false)", async () => {
    // Current production state: no permissions.env declared. Gate must
    // return null (install proceeds). This is the regression guard for
    // the post-merge fix.
    const envNames = (manifest.permissions as Record<string, unknown>).env;
    expect(envNames).toBeUndefined();
    const result = await checkEnvKeyLeakInstallGate(
      manifest.name,
      envNames as string[] | undefined,
      { isBundled: false, envEscapeHatch: false },
    );
    expect(result).toBeNull();
  });

  test("manifest passes env-leak install gate even as a bundled install", async () => {
    // Symmetric assertion — no env declared means no leaks regardless
    // of bundle status or escape-hatch state.
    const envNames = (manifest.permissions as Record<string, unknown>).env;
    const result = await checkEnvKeyLeakInstallGate(
      manifest.name,
      envNames as string[] | undefined,
      { isBundled: true, envEscapeHatch: true },
    );
    expect(result).toBeNull();
  });

  test("synthesized SUBSTACK_SESSION_TOKEN env grant WOULD fail the gate", async () => {
    // Regression guard: if a future PR adds `env: ["SUBSTACK_SESSION_TOKEN"]`
    // to permissions, the install gate must reject it for this (non-bundled)
    // extension. This test will fail at unit-test time, well before anyone
    // tries to install the bad build.
    const badEnv = ["SUBSTACK_SESSION_TOKEN", "SUBSTACK_USER_ID"];
    const result = await checkEnvKeyLeakInstallGate(
      manifest.name,
      badEnv,
      { isBundled: false, envEscapeHatch: false },
    );
    expect(result).toBeInstanceOf(EnvKeyLeakInstallError);
    // Only the credential-shaped name trips ENV_KEY_LEAK_PATTERN
    // (`_TOKEN$`). The plain `SUBSTACK_USER_ID` does not match. detectEnvKeyLeaks
    // is the same predicate the gate uses, so the leak list matches.
    expect((result as EnvKeyLeakInstallError).leakedNames).toEqual([
      "SUBSTACK_SESSION_TOKEN",
    ]);
  });

  test("bundled extension with envEscapeHatch=true would allow even a leak", async () => {
    // Counterpart assertion: the gate's allow-with-audit behavior for
    // bundled extensions. Documents the semantics so a future contributor
    // can't argue "bundled means it bypasses everything" — it doesn't,
    // it bypasses only with the explicit opt-in.
    const result = await checkEnvKeyLeakInstallGate(
      manifest.name,
      ["SUBSTACK_SESSION_TOKEN"],
      { isBundled: true, envEscapeHatch: true },
    );
    expect(result).toBeNull();
  });

  test("detectEnvKeyLeaks classifies the SUBSTACK_* names correctly", () => {
    // Sanity-check the predicate the gate uses so a regex regression in
    // the host doesn't silently start allowing credential-shaped names.
    expect(detectEnvKeyLeaks(["SUBSTACK_SESSION_TOKEN"])).toEqual([
      "SUBSTACK_SESSION_TOKEN",
    ]);
    expect(detectEnvKeyLeaks(["SUBSTACK_USER_ID"])).toEqual([]);
    expect(detectEnvKeyLeaks(["SUBSTACK_PUBLICATION_URL"])).toEqual([]);
    expect(detectEnvKeyLeaks([])).toEqual([]);
    expect(detectEnvKeyLeaks(undefined)).toEqual([]);
  });
});

describe("substack-pilot — settings schema validation", () => {
  test("validateSettingsSchema accepts the manifest's settings block", () => {
    // `validateManifestV2` also runs this internally (see index.test.ts),
    // but pinning it explicitly here gives us a faster-to-read failure
    // when a settings shape drifts.
    const errors: string[] = [];
    validateSettingsSchema(manifest.settings, errors);
    if (errors.length > 0) {
      throw new Error(`validateSettingsSchema rejected settings:\n  ${errors.join("\n  ")}`);
    }
    expect(errors).toEqual([]);
  });

  test("every text setting's `pattern` compiles as a valid RegExp", () => {
    // V2 validation already catches malformed regexes, but we want a
    // direct, behavior-oriented assertion: each pattern must actually
    // run against a representative value.
    const s = manifest.settings ?? {};
    const url = s.substack_publication_url as { pattern: string };
    const tok = s.substack_session_token as { pattern: string };
    const uid = s.substack_user_id as { pattern: string };

    expect(new RegExp(url.pattern).test("https://me.substack.com")).toBe(true);
    expect(new RegExp(url.pattern).test("")).toBe(false); // empty paste rejected

    expect(new RegExp(tok.pattern).test("opaque-token-xyz")).toBe(true);
    expect(new RegExp(tok.pattern).test("")).toBe(false); // empty paste rejected

    expect(new RegExp(uid.pattern).test("12345")).toBe(true);
    expect(new RegExp(uid.pattern).test("")).toBe(false); // empty paste rejected
    expect(new RegExp(uid.pattern).test("abc")).toBe(false); // non-digit rejected
  });

  test("settings keys match the host's filesystem-safe regex", () => {
    // SETTINGS_KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/ — leading lowercase
    // letter, then lowercase alphanumerics + underscores, ≤64 chars.
    // Catches a TitleCase / hyphenated / leading-digit drift.
    const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
    for (const key of Object.keys(manifest.settings ?? {})) {
      expect(key).toMatch(KEY_RE);
      expect(key.includes("..")).toBe(false);
    }
  });
});

describe("substack-pilot — v2→v3 capability migration", () => {
  test("deriveCapsFromExtensionPerms preserves shell + network + storage", () => {
    // The host's v2→v3 migration distributes the extension-wide
    // permissions to each tool's `capabilities` block. shell:true,
    // network: ["*"], and storage:true must survive translation so the
    // runtime PDP grants the same capabilities the manifest declared.
    const caps = deriveCapsFromExtensionPerms(manifest.permissions);
    expect(caps.shell).toBe(true);
    expect(caps.storage).toBe(true);
    expect(caps.network).toEqual({ hosts: ["*"] });
    // No env declared → no env in the derived caps. Regression guard
    // again: if someone re-adds env to the manifest, this assertion
    // breaks alongside the gate test above.
    expect(caps.env).toBeUndefined();
  });

  test("migrateManifestV2ToV3 distributes capabilities to every tool", () => {
    // After migration, every tool definition carries a `capabilities`
    // field — that's the v3 contract the runtime executor consumes.
    // Authored capability declarations would be preserved; this manifest
    // declares none, so every tool inherits the extension-wide ceiling.
    const v3 = migrateManifestV2ToV3(manifest);
    expect(v3.schemaVersion).toBe(3);
    expect(v3._inheritedFromV2).toBe(true);
    for (const tool of v3.tools ?? []) {
      expect(tool.capabilities).toBeDefined();
      expect(tool.capabilities?.shell).toBe(true);
      expect(tool.capabilities?.storage).toBe(true);
      expect(tool.capabilities?.network).toEqual({ hosts: ["*"] });
    }
  });
});
