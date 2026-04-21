#!/usr/bin/env bun
// auto-note — Auto-organizing knowledge vault (persistent process)

import type { ToolCallResult } from "@ezcorp/sdk";
import {
  getChannel,
  createToolDispatcher,
  createMutex,
  toolResult,
  toolError,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import type { VaultIndex, ActionPlan, Config, Category } from "./lib/types";
import type { VaultStats } from "./lib/types";
import {
  loadConfig, saveConfig, getVaultRoot, rebuildIndex,
  planCapture, executeCapture, buildTree, searchNotes,
  readNote, findRelated, refileNote, dailyDigest, computeStats,
} from "./lib/vault";
import { narratePlan, narrateCompleted } from "./lib/narrator";

// ── State ───────────────────────────────────────────────────────

let vaultIndex: VaultIndex = {};
let config: Config = { defaultMode: "approval" };
let initialized = false;
const pendingPlans = new Map<string, ActionPlan>();

/** Override config for tests (bypasses loadConfig / filesystem detection). */
export function _testInit(testConfig: Config, testIndex: VaultIndex): void {
  config = testConfig;
  vaultIndex = testIndex;
  initialized = true;
  pendingPlans.clear();
}

/** Reset state for test isolation. */
export function _testReset(): void {
  vaultIndex = {};
  config = { defaultMode: "approval" };
  initialized = false;
  pendingPlans.clear();
}

let _initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      config = await loadConfig();
      const vaultRoot = getVaultRoot(config);
      vaultIndex = await rebuildIndex(vaultRoot);
      initialized = true;
    } finally {
      _initPromise = null;
    }
  })();
  return _initPromise;
}

// ── Store mutex ─────────────────────────────────────────────────
//
// Serializes ALL handler work (tools/call AND lifecycle) so that stdout
// writes never interleave and shared state (vaultIndex, pendingPlans,
// config) is never mutated concurrently. The channel's run loop is
// itself sequential, but explicit serialization documents the intent
// and guards against future re-entrancy.

const lock = createMutex();

// Wrap a tool body with: (a) mutex, (b) lazy init, (c) per-call vaultRoot.
function guard<A extends Record<string, unknown>>(
  fn: (args: A, vaultRoot: string) => Promise<ToolCallResult>,
): ToolHandler<A> {
  return (args: A) => lock(async () => {
    await ensureInit();
    return fn(args, getVaultRoot(config));
  });
}

// ── Panel State ─────────────────────────────────────────────────

function emitPanelState(stats: VaultStats): void {
  const components: unknown[] = [
    { type: "header", title: "Auto Note", subtitle: "Personal Knowledge Vault" },
    { type: "status", label: "Status", state: "idle" },
    { type: "counter", label: "Notes", value: stats.totalNotes },
    { type: "counter", label: "Action items", value: stats.totalActionItems },
    { type: "divider" },
    {
      type: "kv",
      pairs: Object.entries(stats.categoryCounts).map(([k, v]) => ({
        key: k, value: `${v} notes`,
      })),
    },
    { type: "divider" },
    { type: "text", content: "Recent captures", variant: "emphasis" },
    {
      type: "list",
      items: stats.recentCaptures.map((c) => ({
        label: c.title,
        status: "completed",
        badge: c.category,
        badgeColor: categoryColor(c.category),
      })),
    },
    { type: "divider" },
    {
      type: "progress",
      value: stats.totalActionItems > 0
        ? Math.round((stats.completedActionItems / stats.totalActionItems) * 100)
        : 0,
      label: `${stats.completedActionItems} of ${stats.totalActionItems} action items done`,
    },
    { type: "badge", label: `${config.defaultMode} mode`, color: config.defaultMode === "yolo" ? "green" : "blue" },
  ];

  getChannel().notify("ezcorp/state", { title: "Auto Note", components });
}

function categoryColor(cat: string): string {
  const colors: Record<string, string> = {
    ideas: "purple", tasks: "blue", decisions: "yellow",
    references: "gray", journal: "green", meetings: "red",
  };
  return colors[cat] ?? "gray";
}

// ── Tool Handlers ───────────────────────────────────────────────

const tools: Record<string, ToolHandler> = {
  capture: guard(async (args, vaultRoot) => {
    const text = args.text as string;
    if (!text) return toolError("text is required");

    // Check if this is confirming a pending plan
    const planId = args.planId as string | undefined;
    const confirmed = args.confirmed as boolean | undefined;
    if (planId && confirmed) {
      const plan = pendingPlans.get(planId);
      if (!plan) return toolError("Plan expired or not found");
      pendingPlans.delete(planId);

      vaultIndex = await executeCapture(plan.result, vaultIndex, vaultRoot);
      return toolResult(narrateCompleted(plan.actions));
    }

    const mode = (args.mode as string) ?? config.defaultMode;

    // Optional LLM-supplied classification. The auto-note agent is
    // instructed to semantically classify the capture and pass
    // `category`, `title`, and `tags`. If any are missing the extension
    // falls back to the keyword-based categorizer (see planCapture).
    const overrides = {
      category: args.category as Category | undefined,
      title: args.title as string | undefined,
      tags: args.tags as string[] | undefined,
    };
    const { result, actions } = planCapture(text, vaultIndex, overrides);

    if (mode === "approval") {
      const id = crypto.randomUUID();
      const plan: ActionPlan = {
        id, text, mode: "approval", result, actions,
        createdAt: new Date().toISOString(),
      };
      pendingPlans.set(id, plan);

      // Clean up old plans (>5 min)
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, v] of pendingPlans) {
        if (new Date(v.createdAt).getTime() < cutoff) pendingPlans.delete(k);
      }

      return toolResult([
        narratePlan(actions),
        "",
        `_Plan ID: ${id}_`,
        `_To confirm, call capture with planId="${id}" and confirmed=true_`,
      ].join("\n"));
    }

    // Yolo mode — execute immediately
    vaultIndex = await executeCapture(result, vaultIndex, vaultRoot);
    return toolResult(narrateCompleted(actions));
  }),

  "vault-tree": guard(async () => toolResult(buildTree(vaultIndex))),

  "vault-search": guard(async (args, vaultRoot) => {
    const results = searchNotes(vaultIndex, vaultRoot, {
      query: args.query as string | undefined,
      category: args.category as string | undefined,
      tags: args.tags as string[] | undefined,
    });
    if (results.length === 0) return toolResult("No notes found matching your search.");
    const lines = results.map((r) =>
      `- **${r.title}** (\`${r.path}\`) — ${r.category}, tags: [${r.tags.join(", ")}], ${r.created.slice(0, 10)}`
    );
    return toolResult(`Found ${results.length} notes:\n\n${lines.join("\n")}`);
  }),

  "vault-read": guard(async (args, vaultRoot) => {
    const path = args.path as string;
    if (!path) return toolError("path is required");
    const content = await readNote(vaultRoot, path);
    if (!content) return toolError(`Note not found: ${path}`);
    return toolResult(content);
  }),

  "vault-related": guard(async (args) => {
    const path = args.path as string;
    if (!path) return toolError("path is required");
    const rootNote = vaultIndex[path];
    if (!rootNote) return toolError(`Note not found: ${path}`);
    const depth = Math.min(args.depth as number ?? 1, 3);
    const related = findRelated(path, vaultIndex, depth);

    const lines: string[] = [];
    if (related.directLinks.length > 0) {
      lines.push("**Direct links:**");
      for (const p of related.directLinks) {
        lines.push(`- \`${p}\` — ${vaultIndex[p]?.title ?? p}`);
      }
    }
    if (related.sharedTagNeighbors.length > 0) {
      lines.push("", "**Shared-tag neighbors** (not yet linked):");
      for (const p of related.sharedTagNeighbors) {
        const shared = rootNote.tags.filter((t) => vaultIndex[p]?.tags.includes(t));
        lines.push(`- \`${p}\` — ${vaultIndex[p]?.title ?? p} (shares: ${shared.map((t) => `#${t}`).join(", ")})`);
      }
    }
    if (related.sameCategorySiblings.length > 0) {
      lines.push("", "**Same-category siblings:**");
      for (const p of related.sameCategorySiblings) {
        lines.push(`- \`${p}\` — ${vaultIndex[p]?.title ?? p}`);
      }
    }
    if (lines.length === 0) lines.push("No connections found for this note.");
    return toolResult(lines.join("\n"));
  }),

  "vault-refile": guard(async (args, vaultRoot) => {
    const path = args.path as string;
    if (!path) return toolError("path is required");
    const { newPath, updatedFiles } = await refileNote(path, vaultIndex, vaultRoot, {
      newCategory: args.newCategory as Category | undefined,
      newTags: args.newTags as string[] | undefined,
      addTags: args.addTags as string[] | undefined,
      removeTags: args.removeTags as string[] | undefined,
    });
    const lines = [`Refiled to \`${newPath}\``];
    if (updatedFiles.length > 1) {
      lines.push(`Updated backlinks in ${updatedFiles.length - 1} other note(s):`);
      for (const f of updatedFiles) {
        if (f !== newPath) lines.push(`- \`${f}\``);
      }
    }
    return toolResult(lines.join("\n"));
  }),

  "vault-daily": guard(async (args) => {
    const digest = dailyDigest(vaultIndex, args.date as string | undefined);
    const lines: string[] = [`# Daily Digest — ${digest.date}`, ""];

    lines.push(`## Notes Created (${digest.notesCreated.length})`);
    if (digest.notesCreated.length > 0) {
      for (const n of digest.notesCreated) lines.push(`- \`${n.path}\` — ${n.title} (${n.category})`);
    } else {
      lines.push("_No notes created on this date._");
    }

    lines.push("", `## Open Action Items (${digest.openActionItems.length})`);
    if (digest.openActionItems.length > 0) {
      for (const a of digest.openActionItems) lines.push(`- [ ] \`${a.path}\` — ${a.title}`);
    } else {
      lines.push("_No open action items._");
    }

    if (digest.suggestedConnections.length > 0) {
      lines.push("", "## Suggested Connections");
      for (const s of digest.suggestedConnections) {
        lines.push(`- \`${s.from}\` ↔ \`${s.to}\` (shared: ${s.sharedTags.map((t) => `#${t}`).join(", ")})`);
      }
    }

    return toolResult(lines.join("\n"));
  }),

  configure: guard(async (args) => {
    let changed = false;
    if (args.vaultPath !== undefined) {
      config.vaultPath = args.vaultPath as string;
      changed = true;
    }
    if (args.defaultMode !== undefined) {
      config.defaultMode = args.defaultMode as "approval" | "yolo";
      changed = true;
    }
    if (changed) {
      await saveConfig(config);
      // Re-init if vault path changed
      if (args.vaultPath !== undefined) {
        vaultIndex = await rebuildIndex(getVaultRoot(config));
      }
    }
    return toolResult(JSON.stringify(config, null, 2));
  }),
};

// ── Lifecycle handler ───────────────────────────────────────────
//
// Every hook triggers a panel-state emission. Also serialized through
// the same mutex as tool calls so state reads see a consistent view.

async function lifecycleHandler(): Promise<ToolCallResult> {
  return lock(async () => {
    await ensureInit();
    emitPanelState(computeStats(vaultIndex));
    return toolResult("ok");
  });
}

// ── Exported for testing ────────────────────────────────────────

export { emitPanelState, computeStats, categoryColor, tools, lifecycleHandler };

// ── Production wiring ───────────────────────────────────────────
//
// Replaces the hand-rolled stdin readline + JSON-RPC dispatch. Must
// run at import time so `bun run index.ts` boots immediately.
//
// Wiring order is load-bearing: getChannel() arms the dispatcher
// registration (ensureDispatcherRegistered() in @ezcorp/sdk channel.ts)
// on its first call, replacing rpc.ts's default "channel not ready"
// throw. createToolDispatcher(tools) must run AFTER so _register is the
// real channel-side registrar by the time it's invoked. Lifecycle
// handlers and tools are independent, so swapping the order is
// semantically a no-op for this extension.

const ch = getChannel();
ch.onRequest("lifecycle/run:start", lifecycleHandler);
ch.onRequest("lifecycle/run:complete", lifecycleHandler);
createToolDispatcher(tools);
ch.start();
