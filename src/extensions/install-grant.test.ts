import { test, expect, describe, mock, afterEach } from "bun:test";
import type { ExtensionManifestV2, ExtensionPermissions } from "./types";

// ── Mock the interactive prompt so the TTY paths are deterministic ────
let askAnswers: string[] = [];
const askedPrompts: string[] = [];
mock.module("../ui/prompt", () => ({
  askLine: async (prompt: string) => {
    askedPrompts.push(prompt);
    return askAnswers.shift() ?? "";
  },
}));

// Import AFTER the mock is registered so `install-grant`'s `askLine`
// binding resolves to the mock (bun evaluates the top-level `mock.module`
// statement before this dynamic import runs).
const {
  buildFullGrantFromManifest,
  manifestRequestedGrant,
  stampGrantedAt,
  promptForPermissions,
  promptPerCategory,
} = await import("./install-grant");

// ── Fixtures ──────────────────────────────────────────────────────────

function fullManifest(
  overrides: Partial<ExtensionManifestV2> = {},
  permsOverrides: Record<string, unknown> = {},
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "x",
    entrypoint: "./index.ts",
    permissions: {
      network: ["api.example.com"],
      filesystem: ["$CWD"],
      shell: true,
      env: ["FOO"],
      storage: true,
      spawnAgents: { maxPerHour: 100, maxConcurrent: 4 },
      eventSubscriptions: ["test-ext:ping", "test-ext:pong"],
      schedule: { crons: ["*/15 * * * *"], maxRunsPerDay: 50 },
      ...permsOverrides,
    },
    ...overrides,
  } as unknown as ExtensionManifestV2;
}

// A manifest exercising the Phase-51 capability surfaces + deputy flags.
function capsManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "caps-ext",
    version: "1.0.0",
    description: "x",
    entrypoint: "./index.ts",
    acceptsCallerCaps: true,
    escalateChildCaps: true,
    permissions: {
      taskEvents: true,
      agentConfig: "read",
      // object-form eventSubscriptions
      eventSubscriptions: { events: ["caps-ext:go"], includeFullPayload: true },
      llm: { providers: ["openai"], maxCallsPerHour: 10, maxCallsPerDay: 100 },
      memory: { access: "read", maxWritesPerDay: 10, selfOnly: true },
      lessons: { access: "read", maxWritesPerDay: 10, maxVisibility: "user" },
      search: "inherit",
    },
  } as unknown as ExtensionManifestV2;
}

function setTTY(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  };
}

afterEach(() => {
  askAnswers = [];
  askedPrompts.length = 0;
  delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
});

// ── buildFullGrantFromManifest ────────────────────────────────────────

describe("buildFullGrantFromManifest", () => {
  test("persists EVERY manifest-declared capability (B2 regression)", () => {
    const g = buildFullGrantFromManifest(fullManifest(), 1000);
    expect(g.network).toEqual(["api.example.com"]);
    expect(g.filesystem).toEqual(["$CWD"]);
    expect(g.shell).toBe(true);
    expect(g.env).toEqual(["FOO"]);
    // The three that the old code DROPPED:
    expect(g.storage).toBe(true);
    expect(g.spawnAgents).toEqual({ maxPerHour: 100, maxConcurrent: 4 });
    expect(g.eventSubscriptions).toEqual(["test-ext:ping", "test-ext:pong"]);
    // schedule survives too
    expect(g.schedule?.crons).toEqual(["*/15 * * * *"]);
    // grantedAt stamped for each surviving grant
    for (const k of ["network", "filesystem", "shell", "env", "storage", "spawnAgents", "eventSubscriptions", "schedule"] as const) {
      expect(g.grantedAt[k]).toBe(1000);
    }
  });

  test("grants object-form events + phase-51 caps + deputy flags", () => {
    const g = buildFullGrantFromManifest(capsManifest(), 2000);
    expect(g.taskEvents).toBe(true);
    expect(g.agentConfig).toBe("read");
    expect(g.eventSubscriptions).toEqual(["caps-ext:go"]);
    expect(g.llm?.providers).toEqual(["openai"]);
    expect(g.memory?.access).toBe("read");
    expect(g.lessons?.access).toBe("read");
    expect(g.search).toBe("inherit");
    expect(g.acceptsCallerCaps).toBe(true);
    expect(g.escalateChildCaps).toBe(true);
  });

  test("defaults `now` to Date.now when omitted", () => {
    const before = Date.now();
    const g = buildFullGrantFromManifest(fullManifest());
    expect(g.grantedAt.storage).toBeGreaterThanOrEqual(before);
  });

  test("kill-switch drops the capability tier but keeps classic grants", () => {
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    const g = buildFullGrantFromManifest(fullManifest(), 1000);
    expect(g.storage).toBe(true); // classic — survives
    expect(g.shell).toBe(true);
    expect(g.spawnAgents).toBeUndefined();
    expect(g.eventSubscriptions).toBeUndefined();
    expect(g.schedule).toBeUndefined();
    expect(g.grantedAt.eventSubscriptions).toBeUndefined();
  });

  test("empty permissions → only grantedAt", () => {
    const g = buildFullGrantFromManifest(
      { schemaVersion: 2, name: "e", version: "1.0.0", description: "x", entrypoint: "./i.ts", permissions: {} } as unknown as ExtensionManifestV2,
      1000,
    );
    expect(g).toEqual({ grantedAt: {} });
  });
});

// ── manifestRequestedGrant ────────────────────────────────────────────

describe("manifestRequestedGrant", () => {
  test("mirrors every declared field into a requested grant", () => {
    const r = manifestRequestedGrant(fullManifest());
    expect(r.storage).toBe(true);
    expect(r.spawnAgents).toEqual({ maxPerHour: 100, maxConcurrent: 4 });
    expect(r.eventSubscriptions).toEqual(["test-ext:ping", "test-ext:pong"]);
  });

  test("carries phase-51 caps + deputy flags", () => {
    const r = manifestRequestedGrant(capsManifest());
    expect(r.taskEvents).toBe(true);
    expect(r.agentConfig).toBe("read");
    expect(r.llm).toBeDefined();
    expect(r.memory).toBeDefined();
    expect(r.lessons).toBeDefined();
    expect(r.search).toBe("inherit");
    expect(r.acceptsCallerCaps).toBe(true);
    expect(r.escalateChildCaps).toBe(true);
  });
});

// ── stampGrantedAt ────────────────────────────────────────────────────

describe("stampGrantedAt", () => {
  test("stamps present keys — including a falsy-but-present `search:false`", () => {
    const grant: ExtensionPermissions = { grantedAt: {}, search: false };
    stampGrantedAt(grant, 42);
    expect(grant.grantedAt.search).toBe(42);
  });

  test("leaves absent keys unstamped", () => {
    const grant: ExtensionPermissions = { grantedAt: {}, shell: true };
    stampGrantedAt(grant, 7);
    expect(grant.grantedAt.shell).toBe(7);
    expect(grant.grantedAt.network).toBeUndefined();
  });
});

// ── promptForPermissions ──────────────────────────────────────────────

describe("promptForPermissions", () => {
  test("autoApprove grants the full declared set without prompting", async () => {
    const g = await promptForPermissions(fullManifest(), true);
    expect(g.storage).toBe(true);
    expect(g.eventSubscriptions).toEqual(["test-ext:ping", "test-ext:pong"]);
    expect(askedPrompts).toHaveLength(0);
  });

  test("non-TTY without --yes throws", async () => {
    const restore = setTTY(false);
    try {
      await expect(promptForPermissions(fullManifest(), false)).rejects.toThrow(
        /Interactive terminal required/,
      );
    } finally {
      restore();
    }
  });

  test("interactive 'y' grants the full set (and prints every category)", async () => {
    const restore = setTTY(true);
    askAnswers = ["y"];
    try {
      const g = await promptForPermissions(fullManifest(), false);
      expect(g.storage).toBe(true);
      expect(g.spawnAgents).toBeDefined();
      expect(g.eventSubscriptions).toEqual(["test-ext:ping", "test-ext:pong"]);
    } finally {
      restore();
    }
  });

  test("interactive 'select' routes to per-category (grant all)", async () => {
    const restore = setTTY(true);
    // "select" then a "y" for each of the 8 declared categories.
    askAnswers = ["select", "y", "y", "y", "y", "y", "y", "y", "y"];
    try {
      const g = await promptForPermissions(fullManifest(), false);
      expect(g.network).toEqual(["api.example.com"]);
      expect(g.storage).toBe(true);
      expect(g.spawnAgents).toBeDefined();
      expect(g.eventSubscriptions).toEqual(["test-ext:ping", "test-ext:pong"]);
      expect(g.schedule).toBeDefined();
    } finally {
      restore();
    }
  });

  test("interactive 'n' denies everything", async () => {
    const restore = setTTY(true);
    askAnswers = ["n"];
    try {
      const g = await promptForPermissions(fullManifest(), false);
      expect(g).toEqual({ grantedAt: {} });
    } finally {
      restore();
    }
  });

  test("no declared permissions short-circuits before prompting", async () => {
    const restore = setTTY(true);
    try {
      const g = await promptForPermissions(
        { schemaVersion: 2, name: "e", version: "1.0.0", description: "x", entrypoint: "./i.ts", permissions: {} } as unknown as ExtensionManifestV2,
        false,
      );
      expect(g).toEqual({ grantedAt: {} });
      expect(askedPrompts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("prints spawnAgents default concurrency when maxConcurrent omitted", async () => {
    const restore = setTTY(true);
    askAnswers = ["n"];
    try {
      await promptForPermissions(
        fullManifest({}, { spawnAgents: { maxPerHour: 5 } }),
        false,
      );
      expect(askedPrompts.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});

// ── promptPerCategory (partial approvals) ─────────────────────────────

describe("promptPerCategory", () => {
  test("grants only the approved categories; declines drop events", async () => {
    // order: network, filesystem, shell, env, storage, spawnAgents, events, schedule
    askAnswers = ["n", "y", "n", "y", "n", "y", "n", "y"];
    const g = await promptPerCategory(fullManifest(), 500);
    expect(g.network).toBeUndefined();
    expect(g.filesystem).toEqual(["$CWD"]);
    expect(g.shell).toBeUndefined();
    expect(g.env).toEqual(["FOO"]);
    expect(g.storage).toBeUndefined();
    expect(g.spawnAgents).toBeDefined();
    expect(g.eventSubscriptions).toBeUndefined(); // declined → stripped
    expect(g.schedule).toBeDefined();
    expect(g.grantedAt.filesystem).toBe(500);
  });

  test("approves deputy flags when declared", async () => {
    // caps-ext declares: taskEvents/agentConfig/events(object)/llm/memory/lessons/search
    // promptPerCategory only prompts the categories it knows: events + the two
    // deputy flags here (no network/fs/shell/env/storage/spawnAgents/schedule).
    askAnswers = ["y", "y", "y"]; // events, acceptsCallerCaps, escalateChildCaps
    const g = await promptPerCategory(capsManifest(), 600);
    expect(g.eventSubscriptions).toEqual(["caps-ext:go"]);
    expect(g.acceptsCallerCaps).toBe(true);
    expect(g.escalateChildCaps).toBe(true);
  });
});
