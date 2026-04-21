/**
 * Seed the marketplace with test listings for UI verification.
 *
 * Usage: bun src/db/seed-marketplace.ts
 */
import { initDb, getDb } from "./connection";
import { users, projects, conversations, agentConfigs, memories, memoryAuditLog } from "./schema";
import { createAgentConfig } from "./queries/agent-configs";
import { createListing } from "./queries/marketplace";
import { createVersion } from "./queries/marketplace-versions";
import { upsertRating } from "./queries/marketplace-ratings";
import type { ExtensionManifestV2 } from "../extensions/types";
import { generateSlug } from "../extensions/manifest";
import { CURRENT_MODEL_SENTINEL } from "../types";
import { marketplaceListings } from "./schema";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
const log = logger.child("seed");

const SEED_AGENTS = [
  {
    name: "Code Reviewer",
    description: "Analyzes pull requests for bugs, style issues, and security vulnerabilities. Provides actionable feedback with line-specific suggestions.",
    prompt: "You are a senior code reviewer. Analyze the provided code diff for bugs, security issues, performance problems, and style violations. Provide specific, actionable feedback.",
    category: "Development",
    capabilities: ["llm"],
    tags: ["code-review", "security", "best-practices"],
    featured: true,
  },
  {
    name: "Meeting Summarizer",
    description: "Transforms meeting transcripts into structured summaries with action items, decisions, and key discussion points.",
    prompt: "You are a meeting summarizer. Given a meeting transcript, extract: 1) Key decisions made, 2) Action items with owners, 3) Discussion highlights, 4) Follow-up questions.",
    category: "Productivity",
    capabilities: ["llm"],
    tags: ["meetings", "summaries", "productivity"],
    featured: true,
  },
  {
    name: "SQL Query Builder",
    description: "Generates optimized SQL queries from natural language descriptions. Supports PostgreSQL, MySQL, and SQLite dialects.",
    prompt: "You are a SQL expert. Convert the user's natural language request into an optimized SQL query. Ask clarifying questions about the schema if needed. Always explain the query.",
    category: "Data & Analysis",
    capabilities: ["llm"],
    tags: ["sql", "database", "queries"],
    featured: true,
  },
  {
    name: "Blog Post Writer",
    description: "Drafts engaging blog posts with SEO-optimized titles, structured headings, and a compelling narrative arc.",
    prompt: "You are a professional blog writer. Create well-structured blog posts with compelling titles, clear headings, engaging introductions, and actionable conclusions. Optimize for readability.",
    category: "Writing",
    capabilities: ["llm"],
    tags: ["blog", "writing", "seo", "content"],
  },
  {
    name: "Research Assistant",
    description: "Helps synthesize information from multiple sources, identifies knowledge gaps, and generates structured research briefs.",
    prompt: "You are a research assistant. Help the user explore topics by synthesizing information, identifying key themes, noting contradictions, and suggesting further areas to investigate.",
    category: "Research",
    capabilities: ["llm"],
    tags: ["research", "analysis", "synthesis"],
  },
  {
    name: "Flashcard Generator",
    description: "Creates spaced-repetition flashcards from study material. Supports Anki-compatible format with cloze deletions.",
    prompt: "You are an education specialist. Convert the provided study material into effective flashcards using active recall principles. Use cloze deletions for key terms. Output in Q/A format.",
    category: "Education",
    capabilities: ["llm"],
    tags: ["flashcards", "study", "spaced-repetition"],
  },
  {
    name: "Poem Composer",
    description: "Writes poetry in various styles — haiku, sonnet, free verse, limerick. Can match tone and theme to any subject.",
    prompt: "You are a poet. Compose poems in the requested style, paying careful attention to meter, rhyme scheme, imagery, and emotional resonance. Default to free verse if no style is specified.",
    category: "Creative",
    capabilities: ["llm"],
    tags: ["poetry", "creative-writing", "art"],
  },
  {
    name: "Email Drafter",
    description: "Composes professional emails with appropriate tone, clear structure, and effective calls to action.",
    prompt: "You are an email communication expert. Draft professional emails that are concise, clear, and appropriately toned. Include a subject line, greeting, body, and sign-off.",
    category: "Communication",
    capabilities: ["llm"],
    tags: ["email", "professional", "communication"],
  },
  {
    name: "API Doc Generator",
    description: "Generates OpenAPI/Swagger documentation from code. Infers schemas, documents endpoints, and adds usage examples.",
    prompt: "You are an API documentation specialist. Analyze the provided code and generate comprehensive API documentation including endpoints, request/response schemas, authentication, and usage examples.",
    category: "Development",
    capabilities: ["llm"],
    tags: ["api", "documentation", "openapi", "swagger"],
  },
  {
    name: "Data Visualizer",
    description: "Suggests and generates chart configurations for datasets. Recommends the best visualization type for the data.",
    prompt: "You are a data visualization expert. Analyze the provided data and recommend the most effective chart type. Generate chart configurations (Chart.js or D3 format) with proper labels, colors, and scales.",
    category: "Data & Analysis",
    capabilities: ["llm"],
    tags: ["charts", "visualization", "data"],
  },
  {
    name: "Unit Test Writer",
    description: "Generates comprehensive unit tests with edge cases, mocks, and assertions. Supports Jest, Vitest, and Bun test.",
    prompt: "You are a testing expert. Write thorough unit tests for the provided code. Cover happy paths, edge cases, error conditions, and boundary values. Use descriptive test names.",
    category: "Development",
    capabilities: ["llm"],
    tags: ["testing", "unit-tests", "tdd"],
  },
  {
    name: "Changelog Writer",
    description: "Generates user-friendly changelogs from git commits or PR descriptions. Groups by type (features, fixes, breaking changes).",
    prompt: "You are a changelog writer. Convert the provided commits/PRs into a well-organized changelog grouped by: Added, Changed, Fixed, Removed, Breaking Changes. Write for end-users, not developers.",
    category: "Productivity",
    capabilities: ["llm"],
    tags: ["changelog", "releases", "documentation"],
  },
  {
    name: "Memory Validator",
    description: "Validates Claude Code auto-memory file structure, frontmatter, and index consistency.",
    prompt: "You are a memory system validator. Read all .md files in the Claude Code memory directory. For each file (except MEMORY.md), verify: 1) Valid YAML frontmatter with name, description, and type fields, 2) Type is one of: user, feedback, project, reference, 3) Description is under 150 characters, 4) MEMORY.md is a proper index with links to all memory files. Report any violations found.",
    category: "Productivity",
    capabilities: ["llm"],
    tags: ["memory", "validation", "automation"],
  },
  {
    name: "Memory Organizer",
    description: "Restructures and maintains Claude Code auto-memory files with proper frontmatter and indexing.",
    prompt: "You are a memory system organizer. Given memory content, restructure it into individual files with proper YAML frontmatter (name, description, type). Ensure MEMORY.md is a concise index with one-line pointers. Handle merging duplicates and splitting oversized files. Each memory file should have a clear, specific description under 150 characters.",
    category: "Productivity",
    capabilities: ["llm"],
    tags: ["memory", "organization", "automation"],
  },
  {
    name: "Memory Tester",
    description: "Runs the memory validation test suite and reports pass/fail results.",
    prompt: "You are a test runner for the memory validation system. Run `bun test src/__tests__/memory-validation.test.ts` and interpret the results. Report the pass/fail status of each test case. If any tests fail, explain what is wrong and suggest fixes.",
    category: "Productivity",
    capabilities: ["llm"],
    tags: ["memory", "testing", "automation"],
  },
];

async function seed() {
  await initDb();
  const db = getDb();

  // Ensure we have a test user with working credentials
  const testEmail = "test@test.com";
  const testPassword = "Test123!";
  const { hashPassword } = await import("../auth/password");

  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, testEmail));

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(testPassword);
    await db.insert(users).values({
      id,
      email: testEmail,
      passwordHash,
      name: "Test Admin",
      role: "admin",
    });
    userId = id;
    log.info("Created test user", { email: testEmail });
  }

  log.info("Using user", { userId });

  for (const agent of SEED_AGENTS) {
    // Create agent config
    const config = await createAgentConfig({
      name: agent.name,
      description: agent.description,
      prompt: agent.prompt,
      category: agent.category,
      capabilities: agent.capabilities,
      provider: CURRENT_MODEL_SENTINEL,
      model: CURRENT_MODEL_SENTINEL,
      userId,
    });

    // Build v2 manifest directly. manifest.name must be filesystem-safe
    // (used as a directory name under data/extensions/); slugify the
    // display name so agents like "Code Reviewer" become "code-reviewer".
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: generateSlug(config.name),
      version: "1.0.0",
      description: config.description,
      author: { name: "Marketplace Tester", id: userId },
      agent: {
        prompt: config.prompt,
        category: config.category ?? "Other",
        capabilities: config.capabilities as string[],
      },
      permissions: {},
      tags: agent.tags,
    };

    const listing = await createListing({
      authorId: userId,
      agentConfigId: config.id,
      name: agent.name,
      description: agent.description,
      category: agent.category,
      tags: agent.tags,
      latestVersion: "1.0.0",
    });

    await createVersion(listing.id, "1.0.0", manifest);

    if (agent.featured) {
      await db.update(marketplaceListings)
        .set({ featured: true })
        .where(eq(marketplaceListings.id, listing.id));
    }

    // Add some random ratings to make it look real
    const positiveCount = Math.floor(Math.random() * 8) + 2;
    for (let i = 0; i < positiveCount; i++) {
      const fakeName = `voter-${i}`;
      // Create fake voter users
      const voterId = crypto.randomUUID();
      await db.insert(users).values({
        id: voterId,
        email: `${fakeName}-${listing.id.slice(0, 4)}@test.local`,
        passwordHash: "not-a-real-hash",
        name: `Voter ${i}`,
        role: "member",
      });
      await upsertRating(listing.id, voterId, Math.random() > 0.2); // 80% positive
    }

    log.info("Created listing", { name: agent.name, category: agent.category, ratings: positiveCount });
  }

  log.info("Seeded marketplace listings", { count: SEED_AGENTS.length });

  // ── Seed Agent Teams ──────────────────────────────────────────────
  // Teams reference individual agents by their config IDs.
  // Look up the agents we just created by name.
  const allConfigs = await db.select().from(agentConfigs);
  const configByName = new Map(allConfigs.map((c: any) => [c.name, c]));

  const SEED_TEAMS = [
    {
      name: "Full-Stack Dev Team",
      description: "A coordinated team with a Code Reviewer, Unit Test Writer, and API Doc Generator working together on code changes.",
      prompt: "You are a tech lead orchestrating a full-stack development team. Delegate code review to the Code Reviewer, test generation to the Unit Test Writer, and documentation to the API Doc Generator. Synthesize their outputs into a cohesive deliverable.",
      memberNames: ["Code Reviewer", "Unit Test Writer", "API Doc Generator"],
      autoSpinUp: true,
    },
    {
      name: "Content Pipeline",
      description: "A content production team: the Research Assistant gathers info, the Blog Post Writer drafts the article, and the Email Drafter creates a distribution email.",
      prompt: "You are a content manager orchestrating a production pipeline. First have the Research Assistant gather background material, then pass findings to the Blog Post Writer for drafting, and finally have the Email Drafter create a newsletter email with the article summary.",
      memberNames: ["Research Assistant", "Blog Post Writer", "Email Drafter"],
      autoSpinUp: false,
    },
    {
      name: "Data Analysis Squad",
      description: "A data team combining SQL Query Builder for data extraction, Data Visualizer for charts, and Meeting Summarizer for presenting findings.",
      prompt: "You are a data analytics lead. Use the SQL Query Builder to extract data, the Data Visualizer to create charts, and the Meeting Summarizer to format findings into a clear executive brief. Coordinate the workflow end-to-end.",
      memberNames: ["SQL Query Builder", "Data Visualizer", "Meeting Summarizer"],
      autoSpinUp: true,
    },
    {
      name: "Study Buddy Team",
      description: "An education team: Research Assistant finds materials, Flashcard Generator creates study cards, and Changelog Writer tracks what was learned.",
      prompt: "You are a study coach. Have the Research Assistant find and synthesize learning materials on the given topic, then pass key concepts to the Flashcard Generator for spaced-repetition cards, and use the Changelog Writer to create a learning log of topics covered.",
      memberNames: ["Research Assistant", "Flashcard Generator", "Changelog Writer"],
      autoSpinUp: false,
    },
    {
      name: "Memory Management Team",
      description: "Validates, organizes, and tests the Claude Code auto-memory system. Runs a validate → fix → test workflow.",
      prompt: "You coordinate memory system maintenance. Workflow: 1) Invoke Memory Validator to check the current state of memory files for structural issues, 2) If violations are found, invoke Memory Organizer to fix them, 3) After fixes, invoke Memory Tester to run the validation test suite, 4) Report final status with any remaining issues. Only proceed to the next step if the previous one indicates action is needed.",
      memberNames: ["Memory Validator", "Memory Organizer", "Memory Tester"],
      autoSpinUp: false,
    },
  ];

  for (const team of SEED_TEAMS) {
    // Skip if team already exists
    if (configByName.has(team.name)) {
      log.info("Team already exists, skipping", { name: team.name });
      continue;
    }

    // Resolve member agent config IDs
    const members = team.memberNames
      .map(name => configByName.get(name))
      .filter(Boolean)
      .map((cfg: any) => ({ agentConfigId: cfg.id as string }));

    if (members.length !== team.memberNames.length) {
      log.warn("Skipping team — missing member agents", { name: team.name });
      continue;
    }

    const agentIds = members.map(m => m.agentConfigId);
    await createAgentConfig({
      name: team.name,
      description: team.description,
      prompt: team.prompt,
      category: "team",
      capabilities: ["llm", "agent"],
      provider: CURRENT_MODEL_SENTINEL,
      model: CURRENT_MODEL_SENTINEL,
      userId,
      references: {
        agents: agentIds,
        members,
        autoSpinUp: team.autoSpinUp,
      },
    });

    log.info("Created agent team", { name: team.name, memberCount: team.memberNames.length });
  }

  log.info("Seeded agent teams", { count: SEED_TEAMS.length });

  // ── Seed test project & conversation ─────────────────────────────
  const [existingProject] = await db
    .select()
    .from(projects)
    .where(eq(projects.name, "Test Project"));

  if (!existingProject) {
    const projectId = crypto.randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: "Test Project",
      path: process.cwd(),
    });

    const conversationId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      projectId,
      title: "Welcome conversation",
      userId,
    });

    log.info("Created test project + conversation");
  } else {
    log.info("Test project already exists, skipping");
  }

  // ── Seed TESTENV project & conversation ────────────────────────────
  const [existingTestEnv] = await db
    .select()
    .from(projects)
    .where(eq(projects.name, "TESTENV"));

  if (!existingTestEnv) {
    const testEnvId = crypto.randomUUID();
    await db.insert(projects).values({
      id: testEnvId,
      name: "TESTENV",
      path: `${process.cwd()}/TESTENV`,
    });

    const testEnvConvId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: testEnvConvId,
      projectId: testEnvId,
      title: "TESTENV welcome conversation",
      userId,
    });

    log.info("Created TESTENV project + conversation");
  } else {
    log.info("TESTENV project already exists, skipping");
  }

  // ── Seed memories ───────────────────────────────────────────────
  const existingMemories = await db.select().from(memories);
  if (existingMemories.length === 0) {
    // Get the test project ID for linking
    const [testProj] = await db.select().from(projects).where(eq(projects.name, "Test Project"));
    const testProjectId = testProj?.id ?? null;

    const SEED_MEMORIES = [
      {
        content: "User prefers dark mode across all applications and IDE themes.",
        category: "preferences" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "User is a senior full-stack developer with 8+ years of TypeScript experience.",
        category: "biographical" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "The project uses Bun runtime instead of Node.js. Always use bun commands for running scripts, tests, and package management.",
        category: "technical" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "User follows DRY (Don't Repeat Yourself) principle strictly. Refactor repeated code into shared utilities.",
        category: "preferences" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "Database uses PostgreSQL with Drizzle ORM for schema management and queries.",
        category: "technical" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "Frontend is built with SvelteKit and Tailwind CSS. Components are in web/src/lib/components/.",
        category: "technical" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "User wants comprehensive test coverage for all new features — unit, integration, and e2e tests.",
        category: "decisions_goals" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "The team is working toward a v1.0 launch with multi-agent orchestration as the flagship feature.",
        category: "decisions_goals" as const,
        confidence: "medium" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "User prefers concise responses without trailing summaries. Skip filler words and preamble.",
        category: "preferences" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "Bun's mock.module() is permanent per-process. All test files using it must call restoreModuleMocks() in afterAll.",
        category: "technical" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "User is interested in AI agent workflows and multi-agent coordination patterns.",
        category: "biographical" as const,
        confidence: "medium" as const,
        projectId: testProjectId,
        userId,
      },
      {
        content: "API authentication uses session cookies with name 'ezcorp_session'. Do not use 'pi_session'.",
        category: "technical" as const,
        confidence: "high" as const,
        projectId: testProjectId,
        userId,
      },
    ];

    const { generateEmbedding } = await import("../memory/embeddings");
    log.info("Generating embeddings for seed memories...");

    for (const mem of SEED_MEMORIES) {
      const embedding = await generateEmbedding(mem.content);
      const [inserted] = await db.insert(memories).values(mem).returning();
      await import("./queries/memories").then(({ updateMemory }) =>
        updateMemory(inserted!.id, { embedding }),
      );
      await db.insert(memoryAuditLog).values({
        memoryId: inserted!.id,
        action: "created",
        newContent: mem.content,
        reason: "Seeded for development/testing",
      });
    }

    log.info("Seeded memories with embeddings", { count: SEED_MEMORIES.length });
  } else {
    // Backfill embeddings for any existing memories missing them
    const { sql: sqlTag } = await import("drizzle-orm");
    const missing = await db.select().from(memories).where(sqlTag`embedding IS NULL`);
    if (missing.length > 0) {
      const { generateEmbedding } = await import("../memory/embeddings");
      const { updateMemory } = await import("./queries/memories");
      log.info("Backfilling embeddings for memories without them", { count: missing.length });
      for (const mem of missing) {
        const embedding = await generateEmbedding(mem.content);
        await updateMemory(mem.id, { embedding });
      }
      log.info("Backfilled embeddings", { count: missing.length });
    }
    log.info("Memories already exist, skipping insert", { count: existingMemories.length });
  }

  // ── Ensure bundled extensions ────────────────────────────────────
  const { ensureBundledExtensions } = await import("../extensions/bundled");
  await ensureBundledExtensions();

  // ── Seed LLM credentials from .env.seed ────────────────────────
  await seedCredentials();

  process.exit(0);
}

/** Load API keys and OAuth tokens from .env.seed and store them encrypted in the settings table. */
async function seedCredentials(): Promise<void> {
  const seedFile = Bun.file(import.meta.dir + "/../../.env.seed");
  if (!(await seedFile.exists())) return;

  const text = await seedFile.text();

  // Use the server's encryption key (web/.pi-secret) so credentials are readable at runtime
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const serverSecret = join(import.meta.dir, "../../web/.pi-secret");
  if (existsSync(serverSecret) && !process.env.EZCORP_ENCRYPTION_SECRET) {
    process.env.EZCORP_ENCRYPTION_SECRET = readFileSync(serverSecret, "utf-8").trim();
  }
  // Reset cached key so it picks up the new env var
  const { _resetKeyCache, encrypt } = await import("../providers/encryption");
  _resetKeyCache();
  const { upsertSetting } = await import("./queries/settings");

  // Parse all non-comment KEY=VALUE lines
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }

  let count = 0;

  // ── BYOK API Keys ──
  const API_KEY_MAP: Record<string, string> = {
    SEED_ANTHROPIC_API_KEY: "anthropic",
    SEED_OPENAI_API_KEY: "openai",
    SEED_GOOGLE_API_KEY: "google",
  };
  for (const [envKey, provider] of Object.entries(API_KEY_MAP)) {
    if (vars[envKey]) {
      await upsertSetting(`provider:apiKey:${provider}`, encrypt(vars[envKey]));
      log.info("Stored API key", { provider });
      count++;
    }
  }

  // ── OAuth tokens (access + refresh + expires) ──
  // Format: SEED_{PROVIDER}_OAUTH_ACCESS, SEED_{PROVIDER}_OAUTH_REFRESH, SEED_{PROVIDER}_OAUTH_EXPIRES
  // Optional: SEED_{PROVIDER}_OAUTH_PROJECT_ID (for Google Cloud Code Assist)
  for (const provider of ["GOOGLE", "OPENAI"]) {
    const access = vars[`SEED_${provider}_OAUTH_ACCESS`];
    if (!access) continue;
    const refresh = vars[`SEED_${provider}_OAUTH_REFRESH`] ?? "";
    const expires = Number(vars[`SEED_${provider}_OAUTH_EXPIRES`] || "0");
    const projectId = vars[`SEED_${provider}_OAUTH_PROJECT_ID`];

    const creds: Record<string, unknown> = {
      access,
      refresh: refresh || undefined,
      expires: expires || Date.now() + 3600_000, // default: 1 hour from now
    };
    if (projectId) creds.projectId = projectId;

    const providerKey = provider.toLowerCase();
    await upsertSetting(`provider:oauth:${providerKey}`, encrypt(JSON.stringify(creds)));
    log.info("Stored OAuth credentials", { provider: providerKey });
    count++;
  }

  if (count === 0) {
    log.info("No credentials found in .env.seed");
  }
}

seed().catch((err) => {
  log.error("Seed failed", { error: String(err) });
  process.exit(1);
});
