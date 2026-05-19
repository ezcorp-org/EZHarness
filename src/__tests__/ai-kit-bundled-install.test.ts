/**
 * Tests the bundled install path for `@ezcorp/ai-kit`. ai-kit is ON BY
 * DEFAULT for every EZCorp installation — operators opt OUT by setting
 * `EZCORP_DISABLE_AI_KIT=1` in their environment.
 *
 * Unit-level coverage: `resolveBundledExtensions` opt-out gate.
 * Integration-level coverage: by default, a DB row is created containing
 * the 19 ai-kit tool names, the declared permissions (network localhost +
 * filesystem + EZCORP_* env vars), and is idempotent on repeat startup.
 * With `EZCORP_DISABLE_AI_KIT=1`, no row is created.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface StoredExtension {
  id: string;
  name: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  consecutiveFailures?: number;
  grantedPermissions: {
    network?: string[];
    env?: string[];
    filesystem?: string[];
    shell?: boolean;
    grantedAt: Record<string, number>;
  };
}

let store: Map<string, StoredExtension>;
let nextId = 0;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async (data: Omit<StoredExtension, "id">) => {
    const id = `ext-${++nextId}`;
    const row = { id, ...data } as StoredExtension;
    store.set(data.name, row);
    return row;
  },
  listExtensions: async () => Array.from(store.values()),
  updateExtension: async (id: string, patch: Partial<StoredExtension>) => {
    for (const row of store.values()) {
      if (row.id === id) {
        Object.assign(row, patch);
        return row;
      }
    }
    return null;
  },
  deleteExtension: async (id: string) => {
    for (const [k, v] of store) if (v.id === id) store.delete(k);
  },
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

import {
  ensureBundledExtensions,
  resolveBundledExtensions,
} from "../extensions/bundled";

beforeEach(() => {
  store = new Map();
  nextId = 0;
});

/** Helper to run the install flow with an ephemeral env-var override. */
async function withEnv(flag: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env["EZCORP_DISABLE_AI_KIT"];
  if (flag === undefined) delete process.env["EZCORP_DISABLE_AI_KIT"];
  else process.env["EZCORP_DISABLE_AI_KIT"] = flag;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env["EZCORP_DISABLE_AI_KIT"];
    else process.env["EZCORP_DISABLE_AI_KIT"] = prev;
  }
}

// ── Unit: opt-out env gate ───────────────────────────────────────────────────

describe("resolveBundledExtensions — opt-out gate", () => {
  test("includes ai-kit by default", () => {
    const list = resolveBundledExtensions({});
    expect(list.some((e) => e.name === "ai-kit")).toBe(true);
  });

  test("excludes ai-kit when EZCORP_DISABLE_AI_KIT=1", () => {
    const list = resolveBundledExtensions({ EZCORP_DISABLE_AI_KIT: "1" });
    expect(list.some((e) => e.name === "ai-kit")).toBe(false);
  });

  test("truthy-but-not-'1' values do NOT disable (prevents accidental opt-out)", () => {
    for (const v of ["true", "yes", "on", "0", ""]) {
      const list = resolveBundledExtensions({ EZCORP_DISABLE_AI_KIT: v });
      expect(list.some((e) => e.name === "ai-kit")).toBe(true);
    }
  });

  test("default call without args reads process.env", async () => {
    await withEnv(undefined, async () => {
      const on = resolveBundledExtensions();
      expect(on.some((e) => e.name === "ai-kit")).toBe(true);
    });
    await withEnv("1", async () => {
      const off = resolveBundledExtensions();
      expect(off.some((e) => e.name === "ai-kit")).toBe(false);
    });
  });

  test("ai-kit entry declares expected permissions", () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "ai-kit")!;
    expect(entry.path).toBe("packages/@ezcorp/ai-kit");
    expect(entry.permissions.network).toContain("localhost");
    expect(entry.permissions.network).toContain("127.0.0.1");
    expect(entry.permissions.filesystem).toContain("$CWD");
    expect(entry.permissions.env).toEqual([
      "EZCORP_BASE_URL",
      "EZCORP_API_KEY",
      "EZCORP_SESSION_COOKIE",
    ]);
    expect(entry.permissions.grantedAt["network"]).toBeGreaterThan(0);
    expect(entry.permissions.grantedAt["filesystem"]).toBeGreaterThan(0);
    expect(entry.permissions.grantedAt["env"]).toBeGreaterThan(0);
  });

  test("disabling ai-kit does NOT affect other bundled extensions", () => {
    const list = resolveBundledExtensions({ EZCORP_DISABLE_AI_KIT: "1" });
    // web-search is a baseline bundled extension — it must survive.
    expect(list.some((e) => e.name === "web-search")).toBe(true);
    expect(list.some((e) => e.name === "project-analyzer")).toBe(true);
    // Only ai-kit should be removed.
    expect(list.some((e) => e.name === "ai-kit")).toBe(false);
  });
});

// ── Integration: ensureBundledExtensions installs ai-kit by default ──────────

describe("bundled install: ai-kit (default on)", () => {
  test("default startup creates the ai-kit row, enabled=true", async () => {
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
    });
    const row = store.get("ai-kit");
    expect(row).toBeDefined();
    expect(row!.name).toBe("ai-kit");
    expect(row!.enabled).toBe(true);
  });

  test("EZCORP_DISABLE_AI_KIT=1 → no ai-kit row is created", async () => {
    await withEnv("1", async () => {
      await ensureBundledExtensions();
    });
    expect(store.has("ai-kit")).toBe(false);
    // But baseline bundled extensions still install.
    expect(store.has("web-search")).toBe(true);
  });

  test("manifest declares all 19 locked tool names", async () => {
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
    });
    const row = store.get("ai-kit")!;
    const manifest = row.manifest as { tools?: Array<{ name: string }> };
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    const expected = [
      "assign_task",
      "cancel_run",
      "create_agent",
      "generate_agent",
      "get_agent",
      "get_messages",
      "list_agents",
      "list_extensions",
      "list_models",
      "list_projects",
      "list_sub_conversations",
      "search_mentions",
      "send_message",
      "spawn_agents",
      "spawn_chats",
      "spawn_team",
      "start_assignment",
      "start_chat",
      "stream_run",
    ].sort();
    expect(names).toEqual(expected);
  });

  test("grants localhost network permission", async () => {
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
    });
    const row = store.get("ai-kit")!;
    expect(row.grantedPermissions.network).toContain("localhost");
  });

  test("grants EZCORP_* env vars", async () => {
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
    });
    const row = store.get("ai-kit")!;
    for (const key of ["EZCORP_BASE_URL", "EZCORP_API_KEY", "EZCORP_SESSION_COOKIE"]) {
      expect(row.grantedPermissions.env).toContain(key);
    }
  });

  test("grantedAt timestamps are numeric (registry.ts relies on this shape)", async () => {
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
    });
    const row = store.get("ai-kit")!;
    expect(typeof row.grantedPermissions.grantedAt["network"]).toBe("number");
    expect(typeof row.grantedPermissions.grantedAt["env"]).toBe("number");
    expect(typeof row.grantedPermissions.grantedAt["filesystem"]).toBe("number");
  });

  test("second startup is a no-op when already installed and enabled", async () => {
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
      const firstId = store.get("ai-kit")!.id;
      await ensureBundledExtensions();
      expect(store.get("ai-kit")!.id).toBe(firstId);
    });
  });

  test("second startup RE-ENABLES a bundled extension that was previously disabled", async () => {
    // Simulates the UX-breaking failure mode where a prior server run
    // marked ai-kit `disabled` (e.g. old integrity-check gate, operator
    // toggle, transient bug). We self-heal on the next boot so the
    // default-on promise holds.
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
      const row = store.get("ai-kit")!;
      const priorId = row.id;
      row.enabled = false;
      row.consecutiveFailures = 3;

      await ensureBundledExtensions();
      // Same row (no reinstall), now enabled, failures reset.
      expect(store.get("ai-kit")!.id).toBe(priorId);
      expect(store.get("ai-kit")!.enabled).toBe(true);
      expect(store.get("ai-kit")!.consecutiveFailures).toBe(0);
    });
  });

  test("operator can opt-out after an installed-then-disabled cycle without exception", async () => {
    await withEnv(undefined, async () => {
      await ensureBundledExtensions();
    });
    expect(store.has("ai-kit")).toBe(true);
    // Now the operator sets the disable flag. A subsequent startup should
    // leave the existing row alone (we don't auto-uninstall) but must not
    // throw either. Disable-after-install is a deliberate hands-off policy.
    await withEnv("1", async () => {
      await ensureBundledExtensions();
    });
    // Row persists from the prior install; the disable flag governs fresh
    // installs, not retroactive uninstalls.
    expect(store.has("ai-kit")).toBe(true);
  });
});
