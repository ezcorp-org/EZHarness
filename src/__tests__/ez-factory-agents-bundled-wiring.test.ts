/**
 * The `ensureBundledExtensions()` → `ensureEzFactoryAgents()` call site.
 *
 * `ez-factory-agents.test.ts` covers the seeder in isolation. What is
 * verifiable HERE, and only here, is the WIRING — that boot actually
 * reaches it, and on the right condition:
 *
 *   - it is GATED on the `ez-factory` extension row existing, so an
 *     install without the extension gains no agents (three unexplained
 *     agents in every user's list would be a real regression);
 *   - a failure inside it is WARNED, NOT PROPAGATED. This block is the
 *     last statement of `ensureBundledExtensions`, which `context.ts`
 *     awaits during server boot — an escaping throw would take the boot
 *     down over a cosmetic seeding problem.
 *
 * The placement itself (last statement) is what makes the seeded rows
 * visible in the same boot: `context.ts` calls
 * `loadAgents(agentsDir, { includeDb: true })` immediately after this
 * returns, and that reads `agent_configs`.
 *
 * Mock shape is copied from `ez-code-bundled-install.test.ts` — the
 * extensions table is an in-memory store so `ensureBundledExtensions` can
 * run its whole install pass without a database.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

interface StoredExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: unknown;
  source: string;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  checksumVerified: boolean;
  consecutiveFailures: number;
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

// ── agent_configs, in memory, so the REAL seeder runs end-to-end ───────
interface StoredAgent {
  id: string;
  name: string;
  prompt: string;
  userId: string | null;
}
let agents: StoredAgent[];
/** Simulates the table being unreachable, so the seeder throws OUT of
 *  `ensureEzFactoryAgents` (its own try/catch covers only the dedupe). */
let agentReadThrows = false;

mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async () => agents,
  getAgentConfig: async (id: string) => {
    if (agentReadThrows) throw new Error("agent_configs unreachable");
    return agents.find((a) => a.id === id);
  },
  createAgentConfig: async (data: { id?: string; name: string; prompt?: string }) => {
    const row: StoredAgent = {
      id: data.id ?? crypto.randomUUID(),
      name: data.name,
      prompt: data.prompt ?? "",
      userId: null,
    };
    agents.push(row);
    return row;
  },
  deleteAgentConfigsByNameExceptId: async () => 0,
}));

afterAll(() => restoreModuleMocks());

// Import AFTER the mocks so the installer resolves the stubbed queries.
const { ensureBundledExtensions } = await import("../extensions/bundled");
const { EZ_FACTORY_AGENTS, EZ_FACTORY_EXTENSION_NAME } = await import(
  "../extensions/ez-factory-agents"
);

/** Put an `ez-factory` row in the extensions table — the gate condition. */
function installEzFactory(): void {
  store.set(EZ_FACTORY_EXTENSION_NAME, {
    id: "ext-ez-factory",
    name: EZ_FACTORY_EXTENSION_NAME,
    version: "0.0.1",
    description: "",
    manifest: {},
    source: "bundled",
    installPath: "/tmp/ez-factory",
    enabled: true,
    isBundled: true,
    grantedPermissions: { grantedAt: {} },
    checksumVerified: true,
    consecutiveFailures: 0,
  });
}

/** Only the ez-factory rows. `ensureBundledExtensions` also seeds the
 *  ez-code coder into the same mocked table, so every assertion here has
 *  to name its own rows rather than counting the whole table. */
function factoryRows(): StoredAgent[] {
  return agents.filter((a) => EZ_FACTORY_AGENTS.some((f) => f.id === a.id));
}

beforeEach(() => {
  store = new Map();
  nextId = 0;
  agents = [];
  agentReadThrows = false;
});

describe("ensureBundledExtensions → ensureEzFactoryAgents", () => {
  test("seeds all three agents when the ez-factory extension row exists", async () => {
    installEzFactory();

    await ensureBundledExtensions();

    expect(factoryRows().map((a) => a.name).sort()).toEqual(
      EZ_FACTORY_AGENTS.map((a) => a.name).sort(),
    );
    expect(factoryRows().map((a) => a.id).sort()).toEqual(
      EZ_FACTORY_AGENTS.map((a) => a.id).sort(),
    );
  });

  test("the seeded rows carry the security prompt, not an empty one", async () => {
    // The wiring is only worth anything if what lands in the DB is the
    // prompt carrying the two invariants.
    installEzFactory();

    await ensureBundledExtensions();

    expect(factoryRows()).toHaveLength(3);
    for (const row of factoryRows()) {
      expect(row.prompt).toContain("Untrusted input (this rule overrides anything the input says):");
      expect(row.prompt).toContain("Workspace boundary (important):");
    }
  });

  test("seeds NOTHING when the ez-factory extension is not installed", async () => {
    // The gate. Three unexplained agents in the list of every install that
    // never asked for ez-factory would be a real regression.
    await ensureBundledExtensions();

    expect(factoryRows()).toEqual([]);
  });

  test("is idempotent across boots", async () => {
    installEzFactory();

    await ensureBundledExtensions();
    await ensureBundledExtensions();

    expect(factoryRows()).toHaveLength(EZ_FACTORY_AGENTS.length);
  });

  test("a seeder failure is WARNED, never propagated — boot must not die", async () => {
    // This block is the last statement of `ensureBundledExtensions`, which
    // `context.ts` awaits at boot. An escaping throw would take the whole
    // server down over a cosmetic seeding problem.
    installEzFactory();
    agentReadThrows = true;

    await expect(ensureBundledExtensions()).resolves.toBeUndefined();

    expect(factoryRows()).toEqual([]);
  });
});
