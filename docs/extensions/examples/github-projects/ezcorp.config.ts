// github-projects — connect a GitHub Projects v2 board to the active EZCorp
// project and plan / execute its tickets from a live Hub dashboard.
//
// THIN-tool design (security): every LLM-callable tool emits a reverse-RPC
// INTENT and NEVER carries a board id. The host handler
// (`src/extensions/github-projects-handler.ts`) derives the projectId from the
// calling conversation, resolves the connected board from the 1:1 link, and
// resolves the host-only GitHub token. The sandboxed subprocess never sees a
// token, a board id, or any GitHub host — all GitHub I/O is host-side
// (confused-deputy fix; see `src/integrations/github-projects/types.ts`).
//
// The Hub dashboard shows the viewing user's proposals (Active / History) and
// per-board connection health with Approve / Dismiss / Pause / Resume /
// Reconnect actions. Like ping-loop, it's `bootSpawn` + event-driven so the
// daemon's `github-projects:proposal-update` pushes refresh the page live.

import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "github-projects",
  version: "0.1.0",
  description:
    "Connect a GitHub Projects v2 board to the active EZCorp project, then plan and execute its tickets. A live Hub dashboard surfaces pending board-triggered proposals (approve / dismiss), connection health (pause / resume / reconnect), and history. All GitHub I/O is host-side — the token never reaches the sandbox.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Development",
  tags: ["hub", "pages", "github", "projects", "tickets", "orchestration"],

  // Event-only live path: the daemon's proposal updates + the Hub page-action
  // buttons drive everything, so the subprocess must stay resident to receive
  // them (same rationale as ping-loop). The 6 tools below also spawn it lazily
  // on first chat use, but bootSpawn keeps the dashboard live without a chat.
  bootSpawn: true,

  // ── LLM-callable tools (THIN — each emits a reverse-RPC intent) ──────────
  //
  // None carries a board id. The host derives projectId from the conversation
  // and the board from the link. `itemNodeId` is the board's own opaque node
  // id (returned by `list_tickets`), NOT a board/project id.
  tools: [
    {
      name: "list_tickets",
      description:
        "List tickets (cards) on the GitHub Projects board connected to THIS " +
        "project, newest-updated first. Optionally filter by Status column " +
        "name. Returns each card's itemNodeId (use it with the other tools), " +
        "title, status, and url. Fails clearly if no board is connected.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Optional Status-column name to filter by (e.g. 'In Progress'). " +
              "Omit to list every card.",
          },
          limit: {
            type: "number",
            description: "Max cards to return (default 50).",
          },
        },
      },
    },
    {
      name: "create_ticket",
      description:
        "Create a new ticket on the connected board. For v1 this creates a " +
        "DRAFT issue on the board (it has no repository issue url yet — the " +
        "returned url may be null until it is converted to a real issue). " +
        "Optionally set its initial Status column. Operates on the board " +
        "connected to THIS project; you cannot target another board.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Ticket title (required)." },
          body: { type: "string", description: "Optional ticket body / description." },
          statusName: {
            type: "string",
            description: "Optional Status-column name to place the new card in.",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "update_ticket",
      description:
        "Update an existing ticket's title and/or body. Identify it by the " +
        "`itemNodeId` returned from `list_tickets`. Use `move_ticket` to change " +
        "its Status column.",
      inputSchema: {
        type: "object",
        properties: {
          itemNodeId: {
            type: "string",
            description: "The card's node id (from `list_tickets`).",
          },
          title: { type: "string", description: "New title (optional)." },
          body: { type: "string", description: "New body (optional)." },
        },
        required: ["itemNodeId"],
      },
    },
    {
      name: "move_ticket",
      description:
        "Move a ticket into a different Status column (e.g. 'In Progress' → " +
        "'Done'). Identify it by `itemNodeId`. NOTE: moving a card into a " +
        "column wired to plan/execute on the board may queue a proposal the " +
        "user approves on the Hub.",
      inputSchema: {
        type: "object",
        properties: {
          itemNodeId: {
            type: "string",
            description: "The card's node id (from `list_tickets`).",
          },
          statusName: {
            type: "string",
            description: "Target Status-column name (required).",
          },
        },
        required: ["itemNodeId", "statusName"],
      },
    },
    {
      name: "archive_ticket",
      description:
        "Archive (remove from the active board) a ticket. Identify it by " +
        "`itemNodeId`. Archiving hides the card from the board's columns.",
      inputSchema: {
        type: "object",
        properties: {
          itemNodeId: {
            type: "string",
            description: "The card's node id (from `list_tickets`).",
          },
        },
        required: ["itemNodeId"],
      },
    },
    {
      name: "add_comment",
      description:
        "Add a comment to a ticket's underlying issue. Identify it by " +
        "`itemNodeId`. Only works for cards backed by a real issue (a board " +
        "draft with no issue cannot be commented on yet).",
      inputSchema: {
        type: "object",
        properties: {
          itemNodeId: {
            type: "string",
            description: "The card's node id (from `list_tickets`).",
          },
          body: { type: "string", description: "Comment text (required)." },
        },
        required: ["itemNodeId", "body"],
      },
    },
  ],

  // ── Hub page declaration (Extension Pages Hub) ──────────────────────────
  // Declaring the page IS the grant — the "GitHub Projects" tab appears at
  // /hub/ext:github-projects:dashboard once the extension is enabled.
  pages: [
    {
      id: "dashboard",
      title: "GitHub Projects",
      icon: "GitBranch",
      description:
        "Board-triggered proposals (approve / dismiss), per-board connection " +
        "health (pause / resume / reconnect), and history — refreshed live " +
        "via pushPage on every daemon proposal update.",
    },
  ],

  // ── Agent persona ───────────────────────────────────────────────────────
  agent: {
    prompt: [
      "You are the GitHub Projects assistant. You operate on the GitHub",
      "Projects v2 board connected to the user's ACTIVE EZCorp project. You",
      "NEVER choose or name a board — there is exactly one board per project,",
      "and every tool you call operates on it automatically.",
      "",
      "## What you can do",
      "- `list_tickets` — see the board's cards (filter by Status column).",
      "- `create_ticket` — add a new card (a DRAFT issue in v1; its url may be",
      "  null until converted to a real issue).",
      "- `update_ticket` — edit a card's title / body.",
      "- `move_ticket` — move a card to a different Status column.",
      "- `archive_ticket` — remove a card from the active board.",
      "- `add_comment` — comment on a card's underlying issue (real issues only).",
      "",
      "## How to plan & execute work",
      "1. Start with `list_tickets` to understand the board's columns and what",
      "   is in flight. Always reference cards by the `itemNodeId` the listing",
      "   returns — never invent ids.",
      "2. To plan a ticket, read its title/body, then break it into concrete",
      "   steps and (if asked) record them by updating the ticket or commenting.",
      "3. To execute, do the work in the conversation; when finished, move the",
      "   ticket forward with `move_ticket` (e.g. into 'Done').",
      "4. Moving a card into a column the board owner wired to plan/execute may",
      "   queue a proposal that the user approves on the GitHub Projects Hub",
      "   tab — surface that to the user rather than assuming it auto-ran.",
      "",
      "## If no board is connected",
      "Tools will return a clear 'no board connected to this project' error.",
      "Tell the user to connect a board for this project first (the connect",
      "flow lives in the app, not in chat). Do not retry blindly.",
      "",
      "Be precise about ticket identity and never fabricate a ticket url or",
      "node id. When a card is a board draft with no issue, say so instead of",
      "pretending a comment landed.",
    ].join("\n"),
    category: "Development",
    capabilities: ["project-management", "issue-tracking", "planning"],
    modelRequirements: { tier: "balanced" },
    temperature: 0.2,
  },

  skills: [
    {
      name: "github-projects-playbook",
      description:
        "How board columns map to plan/execute proposals, the draft-vs-issue " +
        "distinction, and the approve/dismiss queue on the Hub.",
      files: ["./knowledge/playbook.md"],
    },
  ],

  // ── Permissions ─────────────────────────────────────────────────────────
  // NO network / shell / env — all GitHub I/O is host-side. The subprocess
  // only emits reverse-RPC intents and renders the Hub page.
  permissions: {
    // The reverse-RPC gate for this extension's verbs. The host handler
    // (`github-projects-handler.ts`) ALSO enforces a bundled-only allowlist
    // by NAME, so this manifest declaration is the per-extension capability
    // marker, not the sole gate.
    custom: { githubProjects: { actions: ["tickets", "control"] } },
    // Page-action events the Hub buttons dispatch (extension-name-prefixed —
    // the Hub dispatcher drops any event not starting with `github-projects:`).
    // Plus the daemon's proposal-update event (for live pushPage refresh) and
    // the two run-lifecycle events that also imply a proposal moved.
    eventSubscriptions: [
      "github-projects:approve",
      "github-projects:dismiss",
      "github-projects:pause",
      "github-projects:resume",
      "github-projects:poll-now",
      "github-projects:refresh",
      "github-projects:proposal-update",
      "task:assignment_update",
      "run:complete",
    ],
    // Optional small KV for the dashboard's last-viewed cursor etc. The
    // authoritative proposal/link state lives in DB tables (host-side).
    storage: true,
  },

  resources: { memory: "128MB" },
});
