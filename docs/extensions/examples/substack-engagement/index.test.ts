// Manifest validation — mirrors substack-pilot/index.test.ts. Pipes the
// config through the host's `validateManifestV2` to catch shape drift.

import { test, expect, describe } from "bun:test";
import manifest from "./ezcorp.config";
import { validateManifestV2 } from "../../../../src/extensions/manifest";

describe("substack-engagement — manifest shape", () => {
  test("required fields are set", () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.name).toBe("substack-engagement");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author.name).toBe("EZCorp");
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  test("entrypoint is the dispatcher", () => {
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("declares all tools by name", () => {
    const names = (manifest.tools ?? []).map((t) => t.name);
    expect(names).toEqual([
      "scan_comments",
      "scan_subscribers",
      "list_queue",
      "approve_item",
      "reject_item",
      "edit_item",
      "send_approved",
      "open_review_queue",
    ]);
  });

  test("every tool has description + object inputSchema", () => {
    for (const t of manifest.tools ?? []) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
  });

  test("open_review_queue advertises the substack-review dock card", () => {
    const open = (manifest.tools ?? []).find((t) => t.name === "open_review_queue");
    expect(open?.cardType).toBe("substack-review");
    expect(open?.cardLayout).toBe("dock");
  });

  test("agent prompt encodes the draft-only hard rule", () => {
    expect(manifest.agent?.prompt).toBeDefined();
    expect(manifest.agent?.prompt).toContain("You draft, you never send");
  });

  test("declares the user-scoped voice-profile + follow-up-sequence entities", () => {
    const entities = (manifest as { entities?: unknown[] }).entities ?? [];
    expect(entities).toHaveLength(2);
    const byType = Object.fromEntries(
      (entities as Array<{ type: string }>).map((e) => [e.type, e]),
    ) as Record<
      string,
      { type: string; scope: string; seed?: Array<{ slug: string; data: Record<string, unknown> }> }
    >;

    const voice = byType["voice-profile"]!;
    expect(voice.scope).toBe("user");
    expect(voice.seed?.[0]?.slug).toBe("default");
    expect(String(voice.seed?.[0]?.data.voiceDescription)).toContain("{file:");

    const seq = byType["follow-up-sequence"]!;
    expect(seq.scope).toBe("user");
    expect(seq.seed?.[0]?.slug).toBe("default");
    expect(Array.isArray(seq.seed?.[0]?.data.steps)).toBe(true);
  });

  test("bundles the engagement skill via a file ref", () => {
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills?.[0]?.name).toBe("engagement");
    expect(manifest.skills?.[0]?.files).toEqual(["skills/engagement/SKILL.md"]);
  });

  test("scripts wire post/preuninstall", () => {
    expect(manifest.scripts?.postinstall).toBe("./scripts/postinstall.ts");
    expect(manifest.scripts?.preuninstall).toBe("./scripts/preuninstall.ts");
  });

  test("settings declare the three SUBSTACK_* fields + model + caps + pacing", () => {
    const keys = Object.keys(manifest.settings ?? {});
    for (const k of [
      "substack_publication_url",
      "substack_session_token",
      "substack_user_id",
      "model",
      "daily_reply_cap",
      "daily_note_cap",
      "min_send_interval_seconds",
      "quiet_hours_start",
      "quiet_hours_end",
    ]) {
      expect(keys).toContain(k);
    }
    // Keys must be filesystem-safe identifiers.
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });

  test("SUBSTACK_* settings are presence-validated (non-empty pattern)", () => {
    const s = manifest.settings ?? {};
    const tok = s.substack_session_token as { type: string; pattern?: string };
    const uid = s.substack_user_id as { type: string; pattern?: string };
    const url = s.substack_publication_url as { type: string; pattern?: string };
    expect(tok.pattern).toBeDefined();
    expect(uid.pattern).toBeDefined();
    expect(url.pattern).toBeDefined();
  });

  test("permissions cover storage + llm + network + shell + schedule", () => {
    expect(manifest.permissions.storage).toBe(true);
    expect(manifest.permissions.llm?.providers).toContain("anthropic");
    expect(manifest.permissions.network).toEqual(["*"]);
    expect(manifest.permissions.shell).toBe(true);
    expect(manifest.permissions.schedule?.crons).toEqual(["*/15 * * * *"]);
    expect(manifest.permissions.schedule?.maxRunsPerDay).toBe(96);
  });

  test("does NOT request permissions.env (credentials live in settings)", () => {
    const perms = manifest.permissions as Record<string, unknown>;
    expect(perms.env).toBeUndefined();
  });

  test("declares review-card events in its own namespace only", () => {
    const subs = manifest.permissions.eventSubscriptions as string[];
    expect(subs).toEqual([
      "substack-engagement:approve",
      "substack-engagement:reject",
      "substack-engagement:edit",
      "substack-engagement:send",
    ]);
    for (const e of subs) expect(e.startsWith("substack-engagement:")).toBe(true);
  });

  test("smokeTest targets the no-network list_queue tool", () => {
    expect(manifest.smokeTest?.tool).toBe("list_queue");
    expect(manifest.smokeTest?.expect.isError).toBe(false);
  });
});

describe("substack-engagement — host validator", () => {
  test("validateManifestV2 accepts the manifest with no errors", () => {
    const result = validateManifestV2(manifest);
    if (!result.valid) {
      throw new Error(
        `validateManifestV2 rejected manifest:\n  ${result.errors.join("\n  ")}`,
      );
    }
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
