import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeAgent, makeAgentConfig } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

// ── Memory team member agents ─────────────────────────────────────────

const memberConfigs = [
  makeAgentConfig({
    id: "mem-val",
    name: "Memory Validator",
    description: "Validates Claude Code auto-memory file structure",
    category: null,
    prompt: "You are a memory system validator.",
  }),
  makeAgentConfig({
    id: "mem-org",
    name: "Memory Organizer",
    description: "Restructures and maintains Claude Code auto-memory files",
    category: null,
    prompt: "You are a memory system organizer.",
  }),
  makeAgentConfig({
    id: "mem-test",
    name: "Memory Tester",
    description: "Runs the memory validation test suite",
    category: null,
    prompt: "You are a test runner for the memory validation system.",
  }),
];

const teamConfig = makeAgentConfig({
  id: "mem-team",
  name: "Memory Management Team",
  description: "Validates, organizes, and tests the Claude Code auto-memory system",
  category: "team",
  prompt: "You coordinate memory system maintenance.",
  references: {
    agents: ["mem-val", "mem-org", "mem-test"],
    extensions: [],
    members: [
      { agentConfigId: "mem-val" },
      { agentConfigId: "mem-org" },
      { agentConfigId: "mem-test" },
    ],
    autoSpinUp: false,
  },
});

const allConfigs = [...memberConfigs, teamConfig];

const memberAgents = memberConfigs.map((c) =>
  makeAgent({
    id: c.id,
    name: c.name,
    description: c.description,
    category: null,
    source: "config",
    prompt: c.prompt,
  })
);

const teamAgent = makeAgent({
  id: "mem-team",
  name: "Memory Management Team",
  description: "Validates, organizes, and tests the Claude Code auto-memory system",
  category: "team",
  source: "config",
});

const allAgents = [...memberAgents, teamAgent];

// ── Tests ─────────────────────────────────────────────────────────────

test.describe("Memory Management Team — Teams Tab", () => {
  test("team appears in Teams tab", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      agents: allAgents,
      agentConfigs: allConfigs,
    });

    await page.goto("/agents");

    // Switch to Teams tab
    await page.getByRole("button", { name: "Teams" }).click();

    // Team should be visible
    await expect(page.getByText("Memory Management Team")).toBeVisible({ timeout: 5000 });
  });

  test("team members are not listed in Agents tab", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      agents: allAgents,
      agentConfigs: allConfigs,
    });

    await page.goto("/agents");

    // On the Agents tab, member agents should be visible but the team should not
    await expect(page.getByText("Memory Validator")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Memory Organizer")).toBeVisible();
    await expect(page.getByText("Memory Tester")).toBeVisible();
  });
});

test.describe("Memory Management Team — Edit Page", () => {
  test("shows Edit Team heading and Chat button", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      agents: allAgents,
      agentConfigs: allConfigs,
    });

    await page.goto("/agents/Memory Management Team");

    await expect(
      page.getByRole("heading", { name: "Edit Team: Memory Management Team" })
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  });

  test("loads all 3 members in member tree", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      agents: allAgents,
      agentConfigs: allConfigs,
    });

    await page.goto("/agents/Memory Management Team");

    await expect(
      page.getByRole("heading", { name: "Edit Team: Memory Management Team" })
    ).toBeVisible({ timeout: 5000 });

    // All 3 member agents should be in the member tree
    await expect(page.locator(".font-medium", { hasText: "Memory Validator" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".font-medium", { hasText: "Memory Organizer" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".font-medium", { hasText: "Memory Tester" })).toBeVisible({ timeout: 5000 });

    // Empty state should not be visible
    await expect(page.getByText("No members added yet")).not.toBeVisible();
  });

  test("does not show Run Agent or Run History for team", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      agents: allAgents,
      agentConfigs: allConfigs,
    });

    await page.goto("/agents/Memory Management Team");

    await expect(
      page.getByRole("heading", { name: "Edit Team: Memory Management Team" })
    ).toBeVisible({ timeout: 5000 });

    await expect(page.getByText("Run Agent")).not.toBeVisible();
    await expect(page.getByText("Run History")).not.toBeVisible();
  });

  test("shows Coordination Instructions label (not System Prompt)", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      agents: allAgents,
      agentConfigs: allConfigs,
    });

    await page.goto("/agents/Memory Management Team");

    await expect(
      page.getByRole("heading", { name: "Edit Team: Memory Management Team" })
    ).toBeVisible({ timeout: 5000 });

    await expect(page.getByText("Coordination Instructions")).toBeVisible();
    await expect(page.getByText("System Prompt")).not.toBeVisible();
  });

  test("member row click expands override panel", async ({ page, mockApi }) => {
    await mockApi({
      projects: [proj],
      agents: allAgents,
      agentConfigs: allConfigs,
    });

    await page.goto("/agents/Memory Management Team");

    await expect(page.locator(".font-medium", { hasText: "Memory Validator" })).toBeVisible({ timeout: 5000 });

    // Click the member row to expand
    await page.locator(".cursor-pointer", { hasText: "Memory Validator" }).click();

    // Override panel content should appear
    await expect(page.locator("text=System Prompt Append")).toBeVisible({ timeout: 3000 });
  });
});
