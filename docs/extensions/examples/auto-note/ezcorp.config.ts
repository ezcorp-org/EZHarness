import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "auto-note",
  version: "1.0.0",
  description: "Jot a quick note and watch it auto-organize into a linked vault — categorized, tagged, and connected",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  category: "Productivity",
  tags: ["notes", "vault", "organization", "productivity", "demo"],

  tools: [
    {
      name: "capture",
      description:
        "Capture a note into the vault. If you are an LLM calling this tool, SEMANTICALLY CLASSIFY the note before calling: pick the best `category` from the six options, generate a concise `title` (<=60 chars), and pick 3-5 relevant `tags`. If you omit those, the extension falls back to a simple keyword matcher that defaults most content to 'ideas/'.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The note — a thought, idea, task, decision, or anything" },
          category: {
            type: "string",
            format: "combo-box",
            description:
              "Pre-classified category. STRONGLY RECOMMENDED when the caller is an LLM — without it most captures fall into 'ideas/' via the keyword fallback. Options: ideas (thoughts, topics to explore), tasks (actionable items), decisions (choices with rationale), references (docs/links/topics to learn), journal (daily observations/reflections), meetings (meeting notes).",
            "x-options": {
              options: ["ideas", "tasks", "decisions", "references", "journal", "meetings"],
              allowCustom: false,
            },
          },
          title: {
            type: "string",
            description:
              "Pre-generated title, <=60 chars, declarative, filler words stripped. If omitted the extension takes the first sentence.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "3-5 lowercase kebab-case tags. Prefer nouns. Include one broad topic (e.g. 'animals', 'auth', 'frontend') and 1-2 specific terms. Merged with any explicit #tags in the text.",
          },
          mode: {
            type: "string",
            format: "combo-box",
            description: "approval = narrate + confirm before each action; yolo = just do it",
            "x-options": { options: ["approval", "yolo"], allowCustom: false },
          },
          planId: { type: "string", description: "If confirming a previously returned plan, pass its ID here" },
          confirmed: { type: "boolean", description: "Set to true to execute a pending approval plan" },
        },
        required: ["text"],
      },
    },
    {
      name: "vault-tree",
      description: "Show the vault folder structure as a tree with note counts per category and tag cloud",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "vault-search",
      description: "Search vault notes by text content, tags, or category",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", format: "search", description: "Search text" },
          category: {
            type: "string",
            format: "combo-box",
            description: "Filter by category",
            "x-options": {
              options: ["all", "ideas", "tasks", "decisions", "references", "journal", "meetings"],
              allowCustom: false,
            },
          },
          tags: {
            type: "array",
            items: { type: "string" },
            format: "tag-input",
            description: "Filter by tags",
            "x-options": { suggestions: [], freeform: true },
          },
        },
      },
    },
    {
      name: "vault-read",
      description: "Read a specific note from the vault by its vault-relative path",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative path (e.g. ideas/my-idea.md)" },
        },
        required: ["path"],
      },
    },
    {
      name: "vault-related",
      description: "Discover notes connected to a given note by shared tags, wikilinks, or category. Use depth=2 to follow links-of-links.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative path of the note to find connections for" },
          depth: { type: "number", description: "Link traversal depth (default 1, max 3)" },
        },
        required: ["path"],
      },
    },
    {
      name: "vault-refile",
      description: "Reorganize a note — change its category, add/remove tags. Automatically fixes all backlinks in other notes.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative path of the note to refile" },
          newCategory: {
            type: "string",
            format: "combo-box",
            description: "Move to a different category",
            "x-options": {
              options: ["ideas", "tasks", "decisions", "references", "journal", "meetings"],
              allowCustom: false,
            },
          },
          newTags: {
            type: "array",
            items: { type: "string" },
            format: "tag-input",
            description: "Replace all tags with these",
            "x-options": { suggestions: [], freeform: true },
          },
          addTags: {
            type: "array",
            items: { type: "string" },
            format: "tag-input",
            description: "Add these tags (keeps existing)",
            "x-options": { suggestions: [], freeform: true },
          },
          removeTags: {
            type: "array",
            items: { type: "string" },
            format: "tag-input",
            description: "Remove these tags",
            "x-options": { suggestions: [], freeform: true },
          },
        },
        required: ["path"],
      },
    },
    {
      name: "vault-daily",
      description: "Daily digest — notes created today, open action items, suggested connections between unlinked but related notes",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", format: "date", description: "Date to summarize (defaults to today)" },
        },
      },
    },
    {
      name: "configure",
      description: "View or update Auto Note settings (vault path, default mode)",
      inputSchema: {
        type: "object",
        properties: {
          vaultPath: { type: "string", description: "Custom vault root directory" },
          defaultMode: {
            type: "string",
            format: "combo-box",
            description: "Default capture mode",
            "x-options": { options: ["approval", "yolo"], allowCustom: false },
          },
        },
      },
    },
  ],

  skills: [
    {
      name: "note-taking-guide",
      description: "How to use Auto Note effectively — capture patterns, vault structure, and tips",
      prompt: [
        "# Auto Note Guide",
        "",
        "## Quick Capture",
        "Just describe your thought naturally. Auto Note will:",
        "1. Detect the category (idea, task, decision, reference, journal, meeting)",
        "2. Extract tags from content",
        "3. Create a markdown file in the right vault folder",
        "4. Link it to related existing notes (bidirectional)",
        "5. Extract action items as checklists + optional task notes",
        "",
        "## Vault Structure",
        "- `ideas/` — Creative thoughts, feature ideas, brainstorms",
        "- `tasks/` — Actionable items (with checkboxes)",
        "- `decisions/` — Choices made with rationale",
        "- `references/` — Links, docs, technical notes",
        "- `journal/` — Daily observations, reflections",
        "- `meetings/` — Meeting notes, action items",
        "",
        "## Modes",
        "- **Approval mode**: Shows what it will do, asks before each action",
        "- **Yolo mode**: Does everything automatically, narrates what it did",
        "",
        "## Tips",
        "- Mention people with @name to auto-tag",
        "- Use #tag inline to force specific tags",
        "- Start with 'Decision:' to force decision category",
        "- Start with 'TODO:' or 'Task:' to force task category",
      ].join("\n"),
    },
    {
      name: "categorization-rules",
      description: "Rules Auto Note uses to categorize notes and extract structure",
      files: ["./knowledge/categorization-rules.md"],
    },
  ],

  agent: {
    prompt: [
      "You are Auto Note, a personal knowledge management assistant.",
      "You help users capture thoughts quickly and organize them into a structured vault of linked markdown notes.",
      "",
      "Your personality: efficient, slightly enthusiastic about organization, always narrates what you're doing.",
      "",
      "## Classification is YOUR job",
      "",
      "The `capture` tool accepts optional `category`, `title`, and `tags`. You MUST fill them",
      "in — the extension's fallback is a naive keyword matcher that drops most content into",
      "`ideas/`. Good organization depends on YOUR semantic reading of the input.",
      "",
      "The six categories:",
      "- **ideas** — creative thoughts, open questions, brainstorms, feature concepts.",
      "- **tasks** — actionable items (imperative verbs, deadlines, TODOs).",
      "- **decisions** — choices made with rationale; trade-offs; \"going with X over Y\".",
      "- **references** — topics to learn about, documentation, links, technical notes.",
      "  This is the right home for \"learn more about X\" or any curiosity/knowledge item.",
      "- **journal** — daily observations, reflections, personal notes in first person.",
      "- **meetings** — meeting notes, attendees, action items FROM a meeting.",
      "",
      "When unsure between ideas and references: if the user wants to LEARN about something",
      "existing → references. If they're proposing something NEW → ideas.",
      "",
      "## Tagging",
      "",
      "Produce 3-5 lowercase kebab-case tags. Include one broad topic (e.g. `animals`, `auth`,",
      "`frontend`) and 1-2 specific terms. Nouns preferred.",
      "",
      "## Title",
      "",
      "Concise (<=60 chars), declarative. Strip filler like \"we should\" or \"I want to\".",
      "",
      "## Workflow",
      "",
      "1. Read the user's message.",
      "2. Classify it: pick category, craft title, choose tags.",
      "3. Call `capture` with `text`, `category`, `title`, `tags`, and `mode`.",
      "4. Narrate the classification: \"Filing under **references** as 'Learn more about cows' with tags [cows, animals, learning].\"",
      "5. Mention any related notes it was linked to, or any action items extracted.",
      "6. In approval mode, present the plan and wait for confirmation.",
      "",
      "You can also help users browse their vault, search notes, discover connections,",
      "reorganize notes, and get daily digests of their knowledge base.",
    ].join("\n"),
    category: "Productivity",
    capabilities: ["note-taking", "organization", "knowledge-management"],
    modelRequirements: { tier: "balanced" },
    temperature: 0.3,
    exampleConversations: [
      {
        title: "Curiosity capture — agent classifies as reference",
        messages: [
          { role: "user", content: "learn more about cows" },
          {
            role: "assistant",
            content: [
              "Filing this as a **reference** — it's a topic to learn about, not an action or an idea.",
              "",
              "- **title:** Learn more about cows",
              "- **tags:** [cows, animals, biology, learning]",
              "- **path:** `references/learn-more-about-cows.md`",
              "",
              "Done! Want me to link it to other animal/biology notes you have?",
              "",
              "_(tool call: capture(text=\"learn more about cows\", category=\"references\", title=\"Learn more about cows\", tags=[\"cows\",\"animals\",\"biology\",\"learning\"], mode=\"yolo\"))_",
            ].join("\n"),
          },
        ],
      },
      {
        title: "Decision capture — agent infers decision even without keyword",
        messages: [
          { role: "user", content: "been thinking about switching our metrics stack from Datadog to Prometheus + Grafana" },
          {
            role: "assistant",
            content: [
              "This is a **decision** in progress — you're weighing a trade-off between tools.",
              "",
              "- **title:** Switch metrics stack from Datadog to Prometheus+Grafana",
              "- **tags:** [metrics, observability, datadog, prometheus, grafana]",
              "- **path:** `decisions/switch-metrics-stack-from-datadog-to-prometheusgrafana.md`",
              "",
              "Linked to 2 existing notes with shared `observability` tag.",
              "",
              "_(tool call: capture(text=..., category=\"decisions\", title=\"Switch metrics stack from Datadog to Prometheus+Grafana\", tags=[\"metrics\",\"observability\",\"datadog\",\"prometheus\",\"grafana\"], mode=\"yolo\"))_",
            ].join("\n"),
          },
        ],
      },
      {
        title: "Task capture — explicit actionable item",
        messages: [
          { role: "user", content: "deploy the staging fix tonight before the demo tomorrow" },
          {
            role: "assistant",
            content: [
              "That's a **task** — clear action with a deadline.",
              "",
              "- **title:** Deploy staging fix before demo",
              "- **tags:** [deploy, staging, demo, urgent]",
              "- **path:** `tasks/deploy-staging-fix-before-demo.md`",
              "",
              "I captured it with high-urgency wording. Action item added to the note.",
              "",
              "_(tool call: capture(text=..., category=\"tasks\", title=\"Deploy staging fix before demo\", tags=[\"deploy\",\"staging\",\"demo\",\"urgent\"], mode=\"yolo\"))_",
            ].join("\n"),
          },
        ],
      },
    ],
  },

  panel: {
    position: "bottom",
    defaultCollapsed: false,
    stateSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        components: { type: "array" },
      },
    },
  },

  lifecycleHooks: ["run:start", "run:complete"],

  scripts: {
    postinstall: "./scripts/postinstall.ts",
  },

  permissions: {
    filesystem: ["$CWD"],
    shell: false,
    storage: true,
  },

  resources: {
    memory: "512MB",
    storage: "10MB",
  },
});
