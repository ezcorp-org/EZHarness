import { defineExtension } from "../../../../src/extensions/sdk/define";
import { ALL_EVENTS } from "./lib/page";

// ── file-organizer — 100%-local, secure file organization ───────────
//
// Architecture spine (see tasks/file-organizer-plan.md):
//   - The background watcher is a HOST-SIDE daemon
//     (src/extensions/file-organizer-daemon.ts, raw node:fs), NOT cron
//     and NOT in-subprocess Bun.watch.
//   - Accept/Reject that touch host folders run HOST-SIDE in the web
//     events route — NOT in a subprocess action handler.
//   - The subprocess fs grant is `$CWD`-only (its own data dir); host
//     folders outside $CWD are touched ONLY by the host daemon/applier.
//   - NO `network` permission anywhere ⇒ "no calls home" by
//     construction. No `shell`. `storage:false` (state is file-based so
//     the host daemon, which has no per-user context, can read/write it).

export default defineExtension({
  schemaVersion: 2,
  name: "file-organizer",
  version: "1.0.0",
  description:
    "Proposes file moves, renames, and garbage cleanup you accept or reject; auto-handles new files in watched folders; recognizes junk/duplicate/stale clutter; co-designs a workflow with an agent and alerts when a file falls outside it. 100% local — no network access.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  category: "Productivity",
  tags: ["files", "organization", "cleanup", "automation", "local"],

  // Whole-extension intent phrasings for the composer suggestion popover —
  // this extension's value spans several tools, so the examples live at the
  // manifest level (surface the extension chip) rather than on any one tool.
  suggestExamples: [
    "help me clean up my downloads folder",
    "organize these files into folders",
    "set up a rule to auto-archive old screenshots",
  ],

  // Flat per-user scalars (SchemaForm). Per-folder rules/modes live in
  // config.json (authored via the Hub + chat agent), NOT here.
  settings: {
    daemon_enabled: { type: "boolean", label: "Enable background watcher", default: true },
    default_mode: {
      type: "select",
      label: "Default mode",
      options: [
        { value: "ask-everything", label: "Ask before every change (default)" },
        { value: "approve-non-destructive-only", label: "Auto-move, confirm deletes" },
        { value: "fully-auto", label: "Fully automatic" },
      ],
      default: "ask-everything",
    },
    quarantine_ttl_days: { type: "number", label: "Quarantine retention (days)", min: 1, max: 365, default: 30 },
    quarantine_cap_gb: { type: "number", label: "Quarantine size cap (GB, 0=off)", min: 0, max: 1000, default: 5 },
    scan_interval_sec: { type: "number", label: "Scan interval (s)", min: 5, max: 3600, default: 45 },
    stability_ticks: { type: "number", label: "Quiescent ticks before acting", min: 1, max: 10, default: 2 },
  },

  // ONE Hub page — the three former pages (Status / Review / Folders &
  // Rules) are now stacked sections on a single dashboard so the
  // extension reads as one app, not three sibling tabs.
  pages: [
    { id: "overview", title: "File Organizer", icon: "FolderTree", description: "Status, review queue, watched folders & rules" },
  ],

  tools: [
    {
      name: "describe_current_workflow",
      description:
        "Interview the user about how they currently organize files (which folders, what they keep vs. toss, naming conventions). Returns a structured summary you can confirm before proposing a target workflow.",
      inputSchema: {
        type: "object",
        properties: {
          notes: { type: "string", description: "Free-text notes gathered from the user about their current habits." },
        },
      },
    },
    {
      name: "propose_target_workflow",
      description:
        "Given the user's described habits, propose a target workflow: which folders to watch, in what mode, with which presets. Returns a markdown table for the user to confirm. Does NOT write config — call apply_workflow_config after confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          folders: {
            type: "array",
            description: "Proposed watched folders.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                mode: { type: "string" },
                presets: { type: "array", items: { type: "string" } },
                backlogPolicy: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
        required: ["folders"],
      },
    },
    {
      name: "apply_workflow_config",
      description:
        "Write the confirmed workflow to config.json. The host daemon picks it up next tick and the Hub reflects it on next render. Validates every folder (refuses .ezcorp/data, normalizes overlaps).",
      inputSchema: {
        type: "object",
        properties: {
          folders: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                mode: { type: "string" },
                presets: { type: "array", items: { type: "string" } },
                backlogPolicy: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
        required: ["folders"],
      },
    },
    {
      name: "set_folder_rules",
      description:
        "Edit a watched folder's presets and custom rules (the structured rule editor replacement — ez-propose is not extensible). Writes config.json.",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          presets: { type: "array", items: { type: "string" } },
          mode: { type: "string" },
        },
        required: ["folderId"],
      },
    },
    {
      name: "teach_rule",
      description:
        "Add a quick garbage/routing rule from a one-line mini-DSL string, e.g. `*.tmp older 7d -> quarantine` or `*.zip larger 100mb -> Archives`. Validates the rule and writes it to the folder's config.",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          rule: { type: "string", description: "Mini-DSL rule line." },
        },
        required: ["folderId", "rule"],
      },
    },
    {
      name: "propose_moves",
      description:
        "Agent-driven proposal: queue one or more move/quarantine suggestions for the user to accept/reject in the Hub Review page. Use for ambiguous files the daemon left unclassified.",
      inputSchema: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            items: {
              type: "object",
              properties: {
                src: { type: "string" },
                dst: { type: "string" },
                reason: { type: "string" },
              },
              required: ["src", "reason"],
            },
          },
        },
        required: ["moves"],
      },
    },
    {
      name: "organize_backlog",
      description:
        "Trigger a one-time sweep of pre-existing files in a watched folder (the include-existing backlog policy on demand).",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
        },
        required: ["folderId"],
      },
    },
  ],

  agent: {
    prompt: [
      "You are the File Organizer — a careful, security-conscious assistant that helps the user",
      "keep their filesystem tidy WITHOUT ever destroying anything irreversibly.",
      "",
      "## Core promises",
      "- Nothing is hard-deleted. 'Delete' means move to a reversible quarantine.",
      "- You never touch a folder the user hasn't explicitly added to the watch list.",
      "- You operate 100% locally — you have no network access.",
      "",
      "## Onboarding (first run)",
      "1. Interview the user about their current habits (describe_current_workflow).",
      "2. Propose a target workflow as a markdown table (propose_target_workflow).",
      "3. After they confirm, write it (apply_workflow_config).",
      "",
      "## Ongoing help",
      "- Teach quick rules from one-liners like `*.tmp older 7d -> quarantine` (teach_rule).",
      "- Edit a folder's presets/mode (set_folder_rules).",
      "- For ambiguous files the watcher couldn't classify, propose moves for review (propose_moves).",
      "- Trigger a one-time backlog sweep on demand (organize_backlog).",
      "",
      "## Modes (read at apply time, never assumed)",
      "- ask-everything: every change waits for the user.",
      "- approve-non-destructive-only: moves/renames auto-apply; deletes are confirmed as a batch.",
      "- fully-auto: everything auto-applies; deletes go silently to quarantine with an undo.",
      "",
      "Always explain WHAT a rule will match and WHY before writing it. When unsure, ask.",
    ].join("\n"),
    category: "Productivity",
    capabilities: ["file-organization", "cleanup", "workflow-design"],
    modelRequirements: { tier: "balanced" },
    temperature: 0.2,
  },

  skills: [
    {
      name: "organization-presets",
      description: "The built-in garbage/routing presets and the quick-rule mini-DSL grammar.",
      files: ["./knowledge/preset-rules.md"],
    },
  ],

  scripts: {
    postinstall: "./scripts/postinstall.ts",
  },

  permissions: {
    // Subprocess: data dir only. Host folders (Desktop/Downloads/…) are
    // outside this jail and are touched ONLY by the host daemon/applier.
    filesystem: ["$CWD"],
    // No network ⇒ no calls home, enforced by the sandbox.
    shell: false,
    // File-based state so the host daemon (no per-user context) can
    // read/write proposals.json / config.json directly.
    storage: false,
    // Every Hub page action — double-gated, mirrored in bundled.ts grant.
    eventSubscriptions: ALL_EVENTS,
  },

  resources: {
    memory: "256MB",
    storage: "500MB",
  },
});
