import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { createMockExtensionsStore } from "./helpers/mock-extensions-store";
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";
import { getProjectRoot } from "../extensions/bundled";
import { join } from "node:path";

const extStore = createMockExtensionsStore({ keyBy: "name" });

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: extStore.updateExtension,
  deleteExtension: extStore.deleteExtension,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

import {
  resolveBundledExtensions,
} from "../extensions/bundled";

beforeEach(() => {
  extStore.reset();
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

  test("ai-kit release declares scoped host API access without host credentials", async () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "ai-kit")!;
    expect(entry.path).toBe("packages/@ezcorp/ai-kit");
    const manifest = (await import("../../packages/@ezcorp/ai-kit/ezcorp.config")).default;
    expect(manifest.permissions.hostApi).toBeDefined();
    expect(manifest.permissions.env ?? []).not.toContain("EZCORP_API_KEY");
    expect(manifest.permissions.env ?? []).not.toContain("EZCORP_SESSION_COOKIE");
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


describe("ai-kit source registration", () => {
  async function manifest() {
    return discoverFirstPartyManifest(join(getProjectRoot(), "packages/@ezcorp/ai-kit"));
  }

  test("discovers the registered v4 source instead of trusting a host projection", async () => {
    const discovered = await manifest();
    expect(discovered.schemaVersion).toBe(4);
    expect(discovered.name).toBe("ai-kit");
    expect(discovered.entrypoint).toBe("./extension.ts");
  });

  test("declares orchestration discovery tools in the executable manifest", async () => {
    const names = (await manifest()).tools?.map((tool) => tool.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("list_agents");
    expect(names).toContain("list_extensions");
  });

  test("declares controlled chat operations rather than shell access", async () => {
    const discovered = await manifest();
    const names = discovered.tools?.map((tool) => tool.name);
    expect(names).toContain("start_chat");
    expect(names).toContain("send_message");
    expect(discovered.permissions.shell).toBeUndefined();
  });

  test("declares bounded fan-out operations in the executable source", async () => {
    const discovered = await manifest();
    const spawn = discovered.tools?.find((tool) => tool.name === "spawn_chats");
    expect(spawn).toBeDefined();
    expect(JSON.stringify(spawn?.inputSchema)).toContain('"maxItems":20');
    expect(discovered.permissions.filesystem).toBeUndefined();
  });

  test("does not make the discovered source persistent at boot", async () => {
    const discovered = await manifest();
    expect(discovered.persistent).toBe(false);
    expect(discovered.permissions.env).toBeUndefined();
    expect(discovered.permissions.network).toBeUndefined();
  });
});
