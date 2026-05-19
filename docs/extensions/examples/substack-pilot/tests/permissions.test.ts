// ── Permissions + settings clamp / coercion guards ──────────────
//
// Three things to lock down:
//
//   1. The LLM-permissions clamp keeps the manifest's declared providers
//      (anthropic, openai) and respects the maxCalls/Hour/Day ceilings.
//      A submitted grant cannot widen the manifest. (Pure host behavior,
//      but its inputs are the manifest values — if those drift, the
//      runtime ceiling drifts with them and silently weakens the cap.)
//
//   2. `isValidForField` accepts every representative valid value and
//      rejects empty / wrong-type / wrong-format pastes for each
//      settings field. This is the same predicate the runtime uses at
//      coerce-time, so testing it through the manifest's actual field
//      shapes pins the contract.
//
//   3. `permissions.network`, `permissions.shell`, `permissions.storage`
//      survive the v2→v3 migration unchanged (a regression guard for
//      anyone "simplifying" the capability translator).
//
// `clampPermissions` (an aggregate of the classic five — network,
// filesystem, shell, env, storage) does NOT exist as a single host
// helper today: those caps clamp inline at the route level per the
// Phase 51 sec-C4 convention. Only LLM/memory/lessons/schedule have
// shared clamp helpers. So we test the one that's relevant to this
// manifest (LLM) plus the per-tool capability declaration that the
// runtime PDP actually reads.

import { test, expect, describe } from "bun:test";
import manifest from "../ezcorp.config";
import {
  clampLlmPermission,
  KNOWN_LLM_PROVIDERS,
} from "../../../../../src/extensions/clamp-permissions";
import {
  isValidForField,
  migrateManifestV2ToV3,
} from "../../../../../src/extensions/manifest";
import type { SettingsField } from "../../../../../src/extensions/types";

describe("clampLlmPermission against the substack-pilot manifest", () => {
  const manifestLlm = manifest.permissions.llm;

  test("manifest declares LLM with both providers and finite call caps", () => {
    // Anchor the inputs the clamp sees. If a future PR removes
    // anthropic+openai from the manifest, the rest of this file's tests
    // will surface that change in their failures rather than passing
    // silently.
    expect(manifestLlm).toBeDefined();
    expect(manifestLlm?.providers).toEqual(["anthropic", "openai"]);
    expect(manifestLlm?.maxCallsPerHour).toBe(120);
    expect(manifestLlm?.maxCallsPerDay).toBe(600);
    expect(manifestLlm?.maxTokensPerCall).toBe(2048);
  });

  test("clamp preserves manifest providers when the user grants both", () => {
    // Submitted grant matches the manifest verbatim — clamp returns the
    // intersection, which is the same set.
    const clamped = clampLlmPermission(
      {
        providers: ["anthropic", "openai"],
        maxCallsPerHour: 120,
        maxCallsPerDay: 600,
        maxTokensPerCall: 2048,
      },
      manifestLlm,
    );
    expect(clamped).toBeDefined();
    expect(clamped?.providers).toEqual(["anthropic", "openai"]);
    expect(clamped?.maxCallsPerHour).toBe(120);
    expect(clamped?.maxCallsPerDay).toBe(600);
    expect(clamped?.maxTokensPerCall).toBe(2048);
  });

  test("clamp narrows to the user-selected provider", () => {
    // Defense-in-depth: the user picks only anthropic. Clamp returns the
    // intersection. The manifest still declared openai, but the user's
    // grant is the operational ceiling for THIS install.
    const clamped = clampLlmPermission(
      {
        providers: ["anthropic"],
        maxCallsPerHour: 50,
        maxCallsPerDay: 300,
      },
      manifestLlm,
    );
    expect(clamped?.providers).toEqual(["anthropic"]);
    expect(clamped?.maxCallsPerHour).toBe(50); // user-chosen, below manifest cap
    expect(clamped?.maxCallsPerDay).toBe(300);
  });

  test("clamp drops a submitted provider the manifest did not declare", () => {
    // A submitted grant cannot smuggle in a provider beyond the manifest
    // (e.g. "mistral"). Clamp filters it out.
    const clamped = clampLlmPermission(
      {
        providers: ["anthropic", "mistral"],
        maxCallsPerHour: 60,
        maxCallsPerDay: 300,
      },
      manifestLlm,
    );
    expect(clamped?.providers).toEqual(["anthropic"]);
    // The granted provider list ends up as a subset of manifest providers.
    // Cast through `readonly string[]` to satisfy the typed-tuple assertion
    // — KNOWN_LLM_PROVIDERS is `readonly [...]` but we only need
    // string-set membership semantics here.
    expect(KNOWN_LLM_PROVIDERS as readonly string[]).toContain("anthropic");
  });

  test("clamp ceilings the per-hour/per-day counts to the manifest cap", () => {
    // A submitted grant cannot raise the manifest cap. The user-side cap
    // is min(submitted, manifest) — submitted=999 here, manifest=120.
    const clamped = clampLlmPermission(
      {
        providers: ["anthropic"],
        maxCallsPerHour: 999,
        maxCallsPerDay: 9999,
      },
      manifestLlm,
    );
    expect(clamped?.maxCallsPerHour).toBe(120);
    expect(clamped?.maxCallsPerDay).toBe(600);
  });
});

describe("settings — isValidForField against manifest fields", () => {
  // The host's clamp-time `coerceValue` routes through `isValidForField`
  // for accept/reject. Pinning behavior here means a coerce-time
  // regression breaks this file's tests before reaching the runtime.

  const s = manifest.settings ?? {};
  const url = s.substack_publication_url as SettingsField;
  const tok = s.substack_session_token as SettingsField;
  const uid = s.substack_user_id as SettingsField;

  test("substack_publication_url accepts a real URL, rejects empties + non-strings", () => {
    expect(isValidForField(url, "https://me.substack.com")).toBe(true);
    expect(isValidForField(url, "http://me.substack.com")).toBe(true);
    expect(isValidForField(url, "")).toBe(false); // ^https?://[^\s]+$ requires content
    expect(isValidForField(url, "   ")).toBe(false); // \S in pattern rejects spaces
    expect(isValidForField(url, 12345)).toBe(false); // wrong type
  });

  test("substack_session_token accepts any non-empty string, rejects empty", () => {
    expect(isValidForField(tok, "opaque-token-xyz")).toBe(true);
    expect(isValidForField(tok, "x")).toBe(true); // ^.+$ accepts single char
    expect(isValidForField(tok, "")).toBe(false); // presence guard
    expect(isValidForField(tok, null)).toBe(false);
    expect(isValidForField(tok, undefined)).toBe(false);
  });

  test("substack_user_id accepts digits-only, rejects everything else", () => {
    expect(isValidForField(uid, "12345")).toBe(true);
    expect(isValidForField(uid, "1")).toBe(true);
    expect(isValidForField(uid, "")).toBe(false);
    expect(isValidForField(uid, "abc")).toBe(false);
    expect(isValidForField(uid, "12345 ")).toBe(false); // trailing space
    expect(isValidForField(uid, " 12345")).toBe(false); // leading space
    expect(isValidForField(uid, 12345)).toBe(false); // number, not string
  });
});

describe("classic-five permissions survive v2→v3 migration", () => {
  // The Phase 51 sec-C4 convention keeps network/filesystem/shell/env/
  // storage clamp logic inline at the route level — no shared helper. The
  // migration translator (`migrateManifestV2ToV3`) is the single
  // host-side touchpoint that re-shapes these declarations into the v3
  // per-tool capabilities. If it drops or weakens one of our declared
  // capabilities, the runtime PDP will refuse our tools at execution
  // time. Pin the translation here.
  const v3 = migrateManifestV2ToV3(manifest);

  test("network: ['*'] becomes network.hosts: ['*'] on every tool", () => {
    for (const tool of v3.tools ?? []) {
      expect(tool.capabilities?.network).toEqual({ hosts: ["*"] });
    }
  });

  test("shell:true survives on every tool", () => {
    for (const tool of v3.tools ?? []) {
      expect(tool.capabilities?.shell).toBe(true);
    }
  });

  test("storage:true survives on every tool", () => {
    for (const tool of v3.tools ?? []) {
      expect(tool.capabilities?.storage).toBe(true);
    }
  });

  test("no env capability on any tool (manifest declared none)", () => {
    // Regression guard paired with install-gate.test.ts's
    // "manifest passes env-leak install gate" — if env is re-added at
    // the manifest level, the migrated capability declarations would
    // surface it here too.
    for (const tool of v3.tools ?? []) {
      expect(tool.capabilities?.env).toBeUndefined();
    }
  });

  test("no filesystem capability on any tool (manifest declared none)", () => {
    // substack-pilot doesn't request filesystem — all persistence goes
    // through `storage:true` via the host-mediated Storage API. If a
    // future PR adds `permissions.filesystem`, this assertion will
    // surface it.
    for (const tool of v3.tools ?? []) {
      expect(tool.capabilities?.filesystem).toBeUndefined();
    }
  });
});
