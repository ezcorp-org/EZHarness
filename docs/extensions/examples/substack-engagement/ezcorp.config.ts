import { defineExtension } from "../../../../src/extensions/sdk/define";
import type { EntityDeclaration } from "@ezcorp/sdk/entities";

// Entities are declared as a separately-typed `const` so their
// heterogeneous (voice-profile vs follow-up-sequence) shapes are
// validated against `EntityDeclaration[]` directly. Inlining both into
// `defineExtension(...)` widens the array element type and trips TS's
// excess-property check on the manifest's `permissions` block (the SDK's
// static manifest type lags the host's — `llm`/`schedule` are accepted
// at runtime via `validateManifestV2`). Extracting keeps inference clean.
const entities: EntityDeclaration[] = [
  {
    type: "voice-profile",
    label: "Voice Profile",
    pluralLabel: "Voice Profiles",
    scope: "user",
    cascadeOnUninstall: false,
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        voiceDescription: { type: "string", maxLength: 4000 },
        doRules: { type: "array", items: { type: "string" } },
        dontRules: { type: "array", items: { type: "string" } },
        sampleReplies: { type: "array", items: { type: "string" } },
      },
      required: ["name", "voiceDescription"],
      additionalProperties: false,
    },
    preview: "Voice '{name}':\n{voiceDescription}",
    seed: [
      {
        slug: "default",
        data: {
          name: "Default Voice",
          voiceDescription: "{file:./prompts/voice-sample.md}",
          doRules: [
            "Ask a genuine follow-up question when it fits.",
            "Mirror the other person's tone and energy.",
            "Keep replies to 2-3 sentences.",
          ],
          dontRules: [
            "No corporate filler ('Thanks for your feedback!').",
            "No over-apologizing.",
            "No promises you can't keep.",
          ],
          sampleReplies: [],
        },
      },
    ],
  },
  // Welcome-DM follow-up sequence (user-scoped, single profile).
  // `scan_subscribers` reads the `default` sequence and schedules a
  // follow-up row per step (offsets in DAYS for human authoring). When
  // absent, lib/subscribers.ts falls back to a built-in 3-day + 7-day
  // sequence. Follow-up rows are drafted LAZILY at due time so they
  // reflect the latest voice.
  {
    type: "follow-up-sequence",
    label: "Follow-up Sequence",
    pluralLabel: "Follow-up Sequences",
    scope: "user",
    cascadeOnUninstall: false,
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              offsetDays: { type: "number", minimum: 0 },
              note: { type: "string", maxLength: 500 },
            },
            required: ["offsetDays"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "steps"],
      additionalProperties: false,
    },
    preview: "Sequence '{name}'",
    seed: [
      {
        slug: "default",
        data: {
          name: "Default Sequence",
          steps: [
            { offsetDays: 3, note: "Light 3-day check-in — anything they want more of?" },
            { offsetDays: 7, note: "7-day nudge — point to one popular past post." },
          ],
        },
      },
    ],
  },
  // Targeted Notes the user wants engaged (Phase 3). `scan_notes` reads
  // the `default` list's noteRefs, fetches each, and drafts a comment.
  // Seeded empty — the user adds note refs on the extension detail page.
  {
    type: "targeted-notes-list",
    label: "Targeted Notes List",
    pluralLabel: "Targeted Notes Lists",
    scope: "user",
    cascadeOnUninstall: false,
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        noteRefs: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
    preview: "Targeted notes '{name}'",
    seed: [
      {
        slug: "default",
        data: { name: "Default Targets", noteRefs: [] },
      },
    ],
  },
];

// ── substack-engagement ──────────────────────────────────────────
//
// A draft-and-approve Substack community-engagement agent across three
// pillars — comment replies, welcome DMs + follow-ups, and targeted
// Notes commenting. The agent DRAFTS every outbound message into a
// review queue; the human approves / edits / rejects / sends. Nothing
// sends autonomously in v1 (locked decision #1).
//
// Architecture mirrors `substack-pilot`:
//  - All Substack I/O goes through a single injectable `SubstackClient`
//    seam (`lib/substack-client.ts`). Unit tests inject a fake; the live
//    transport (substack-mcp stdio child + substack-api lib / Playwright)
//    is wired behind the seam and marked `// LIVE-UNTESTED` (no session
//    cookie this run — locked decision #7).
//  - Credentials live in `settings.substack_*`, read at tool-invocation
//    time via `ctx.invocationMetadata.settings`. We do NOT request
//    `permissions.env`: `substack_session_token` matches the host's
//    `ENV_KEY_LEAK_PATTERN` install-gate (`clamp-permissions.ts` →
//    `checkEnvKeyLeakInstallGate`), which refuses install for non-bundled
//    extensions. Settings storage is the correct surface anyway — it
//    persists per-user, never touches host process env, and is what
//    `lib/substack-client.ts` reads. (Rationale copied from
//    substack-pilot/ezcorp.config.ts:188-226.)
//  - The review queue lives in an OWNERLESS store (locked decision #4):
//    scheduled cron fires are ownerless and user-scope storage needs an
//    owner. The decision names "project" scope; the SDK runtime Storage
//    has no such scope, so index.ts binds the only ownerless scope that
//    exists — `Storage("global")` — which satisfies the decision's intent.
//
// Permission contract:
//  - storage     — review queue + voice-profile entity + scan cursors
//  - llm         — voice drafting (claude-sonnet-4-6 default; matters)
//  - network:[*] — the live SubstackClient transport reaches Substack
//  - shell:true  — spawn the substack-mcp stdio child behind the seam
//  - schedule    — the */15 cron drafts (never sends) on a loop
//  - appendMessages — reserved for future "your queue has N drafts" nudges

export default defineExtension({
  schemaVersion: 2,
  name: "substack-engagement",
  version: "1.0.0",
  description:
    "Draft-and-approve Substack engagement: comment replies, welcome DMs + " +
    "follow-up sequences, and targeted Notes commenting — every message is " +
    "queued for human review before it sends.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",

  // ── Persistent voice + draft-only operating rules ───────────────
  agent: {
    prompt: [
      "You are a Substack community-engagement assistant. You DRAFT outbound",
      "messages — comment replies, welcome DMs, and Notes comments — in the",
      "creator's voice, and you queue every draft for the human to review.",
      "",
      "HARD RULE: You draft, you never send. Every send is gated on the human",
      "approving the queued item. Never describe a draft as 'sent'. If asked to",
      "send, explain that you can only queue drafts and that the human approves",
      "and sends from the review queue.",
      "",
      "Voice: warm, concise, human — never a brand account. Ask a genuine",
      "follow-up when it fits, mirror the other person's tone, keep it short.",
      "No corporate filler, no over-apologizing, no promises you can't keep.",
      "",
      "The runtime-editable `voice-profile` entity refines this voice; when it",
      "exists, its do/don't rules and sample replies take precedence. Use",
      "`open_review_queue` to show the human the pending drafts.",
    ].join("\n"),
    category: "communication",
  },

  tools: [
    {
      name: "scan_comments",
      description:
        "Read comments on the creator's own posts and draft a reply in their " +
        "voice for each new one. Enqueues each draft as a pending review item. " +
        "Drafts only — never sends.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Optional cap on comments to scan this run.",
          },
        },
      },
    },
    {
      name: "scan_subscribers",
      description:
        "Poll for new subscribers (cursor-based diff), draft a welcome DM in " +
        "the creator's voice for each, and schedule a timed follow-up sequence. " +
        "Drafts only — never sends.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "scan_notes",
      description:
        "For each targeted Note (from the targeted-notes-list), fetch it and " +
        "draft a comment in the creator's voice. Enqueues each as a pending " +
        "note-comment. Drafts only — sending is pacing-gated and never " +
        "force-sent.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_queue",
      description:
        "List the review queue. Optionally filter by status " +
        "(pending|approved|rejected|sent|failed) or kind " +
        "(reply|welcome-dm|note-comment). No network access.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
        },
      },
    },
    {
      name: "approve_item",
      description: "Mark a queued draft as approved (eligible for send_approved).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "reject_item",
      description: "Reject a queued draft so it is never sent.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "edit_item",
      description: "Replace a queued draft's editable body before approval.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          draft_body: { type: "string" },
        },
        required: ["id", "draft_body"],
      },
    },
    {
      name: "send_approved",
      description:
        "Send every APPROVED queue item via the SubstackClient and flip it to " +
        "sent/failed. Refuses any item that is not approved. Optionally narrow " +
        "to a single 'id'.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    },
    {
      name: "open_review_queue",
      description:
        "Open the interactive review-queue card showing pending + approved " +
        "drafts with Approve & Send / Edit / Reject actions.",
      inputSchema: { type: "object", properties: {} },
      cardType: "substack-review",
      cardLayout: "dock",
    },
  ],

  // Runtime-editable voice profile + welcome-DM follow-up sequence.
  // Declared above as a typed `const` so the heterogeneous entity shapes
  // are validated against EntityDeclaration[] without widening the
  // manifest's inferred type (see the `entities` const's header comment).
  entities,

  skills: [
    {
      name: "engagement",
      description:
        "The engagement playbook: how to draft replies, welcome DMs, and Notes " +
        "comments in the creator's voice — and the draft-only discipline.",
      files: ["skills/engagement/SKILL.md"],
    },
  ],

  scripts: {
    postinstall: "./scripts/postinstall.ts",
    preuninstall: "./scripts/preuninstall.ts",
  },

  settings: {
    // ── Substack credentials (presence-validated; never logged) ────
    substack_publication_url: {
      type: "text",
      label: "Publication URL",
      description: "e.g. https://yourname.substack.com",
      pattern: "^https?://[^\\s]+$",
    },
    substack_session_token: {
      type: "text",
      label: "Session token",
      description: "From the substack-mcp creator guide (kept locally, never logged).",
      // Presence-only guard — V2 settings schema doesn't expose minLength/
      // required, so a non-empty pattern rejects blank pastes up front.
      pattern: "^.+$",
    },
    substack_user_id: {
      type: "text",
      label: "User ID",
      description: "Your Substack numeric user id.",
      pattern: "^\\d+$",
    },
    // ── Drafting model (voice quality matters — sonnet default) ────
    model: {
      type: "text",
      label: "Drafting model",
      description: "Model used to draft replies (default claude-sonnet-4-6).",
      default: "claude-sonnet-4-6",
    },
    // ── Daily caps + pacing knobs (Phase 3 enforces note pacing) ───
    daily_reply_cap: {
      type: "number",
      label: "Daily reply cap",
      description: "Max comment replies to draft per day.",
      default: 100,
      min: 0,
      integer: true,
    },
    daily_note_cap: {
      type: "number",
      label: "Daily Notes-comment cap",
      description: "Max Notes comments to SEND per day (pacing guard).",
      default: 100,
      min: 0,
      integer: true,
    },
    min_send_interval_seconds: {
      type: "number",
      label: "Min seconds between Notes sends",
      description: "Minimum spacing between Notes-comment sends (anti-spam pacing).",
      default: 1,
      min: 0,
      integer: true,
    },
    quiet_hours_start: {
      type: "number",
      label: "Quiet hours start (0-23)",
      description: "Hour to stop sending Notes comments (local). -1 disables.",
      default: -1,
      min: -1,
      max: 23,
      integer: true,
    },
    quiet_hours_end: {
      type: "number",
      label: "Quiet hours end (0-23)",
      description: "Hour to resume sending Notes comments (local).",
      default: -1,
      min: -1,
      max: 23,
      integer: true,
    },
    note_jitter_seconds: {
      type: "number",
      label: "Notes-send jitter (seconds)",
      description: "Random extra spacing (0..N s) added to the min interval between Notes sends.",
      default: 0,
      min: 0,
      integer: true,
    },
    note_ramp_start: {
      type: "number",
      label: "Notes ramp start (day-0 cap)",
      description: "Day-0 Notes-send cap; ramps up by the step each day until the daily cap. Set >= cap to disable.",
      default: 100,
      min: 0,
      integer: true,
    },
    note_ramp_step: {
      type: "number",
      label: "Notes ramp step (per day)",
      description: "Daily increase to the Notes-send cap during ramp-up.",
      default: 0,
      min: 0,
      integer: true,
    },
    tz_offset_minutes: {
      type: "number",
      label: "Timezone offset (minutes from UTC)",
      description: "Local-time offset for quiet hours + daily-cap rollover (e.g. -300 for US Eastern).",
      default: 0,
      integer: true,
    },
  },

  // lib/substack-client.ts lazily imports `@modelcontextprotocol/sdk` to
  // drive the substack MCP child. Verify-only (host does NOT install it):
  // it must exist in the deployment's node_modules (app root package.json).
  // See src/extensions/npm-deps.ts.
  npmDependencies: { "@modelcontextprotocol/sdk": "^1.29.0" },

  permissions: {
    storage: true,
    llm: {
      providers: ["anthropic", "openai"],
      maxCallsPerHour: 200,
      maxCallsPerDay: 1000,
      maxTokensPerCall: 2048,
    },
    network: ["*"], // the live SubstackClient transport reaches Substack
    shell: true, // spawn the substack-mcp stdio child behind the seam
    schedule: {
      crons: ["*/15 * * * *"],
      maxRunsPerDay: 96,
      purpose:
        "Periodically scan comments, new subscribers, and targeted Notes to " +
        "draft (never send) engagement messages into the review queue.",
    },
    // No `eventSubscriptions`: the review card (SubstackReviewCard.svelte)
    // drives Approve & Send / Edit / Reject by POSTing the approve_item /
    // edit_item / send_approved / reject_item tools to `/api/tool-invoke`
    // directly (open-question #2 resolution). There is no bidirectional
    // canvas-event channel, so no event grants are needed.
    // Reserved for a future "you have N drafts to review" nudge. The host
    // forces excluded=true regardless of this flag (the field is for a
    // future opt-in tier); declared here to document the intent.
    appendMessages: { excludedDefault: true },
    // NOTE: no `env` grant. SUBSTACK_* values come from settings, not host
    // env — see the header comment for the install-gate rationale.
  },

  // Deterministic acceptance: the no-network list_queue tool round-trips
  // with isError:false on an empty queue. Required for tool/multi installs.
  smokeTest: {
    tool: "list_queue",
    input: {},
    expect: { isError: false },
  },
});
