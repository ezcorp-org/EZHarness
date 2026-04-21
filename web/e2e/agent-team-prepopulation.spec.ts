import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeAgentConfig } from "./fixtures/data.js";

// These tests guard the pre-population of the "selected items" in agent and
// team edit/view pages. They were added after a regression where a team's
// `teamToolScope` was being dropped by the DB query and so never came back
// into the UI on reload — the UI appeared to "forget" the saved selection.

test.describe("Agent edit page — pre-populated model/provider/etc", () => {
  test("editable config agent shows saved model, provider, temperature, maxTokens in form", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-prepop-1",
      name: "prepop-agent",
      description: "Pre-populated agent",
      prompt: "You are helpful.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      temperature: 0.7,
      maxTokens: 4096,
    });
    await mockApi({
      agents: [makeAgent({
        name: "prepop-agent",
        source: "config",
        id: "cfg-prepop-1",
        prompt: "You are helpful.",
      })],
      agentConfigs: [config],
    });

    await page.goto("/agents/prepop-agent");

    // The AgentConfigForm passes initial values into each input; confirm the
    // fields render with the saved values pre-populated.
    await expect(page.getByLabel("Name")).toHaveValue("prepop-agent");
    await expect(page.getByLabel("Temperature")).toHaveValue("0.7");
    await expect(page.getByLabel("Max Tokens")).toHaveValue("4096");
  });

  test("editable config agent shows attached extensions as chips below the picker", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-ext-1",
      name: "ext-agent",
      description: "Agent with extensions",
      prompt: "P",
      extensions: ["ext-analyzer", "ext-formatter"],
    });
    await mockApi({
      agents: [makeAgent({
        name: "ext-agent",
        source: "config",
        id: "cfg-ext-1",
        prompt: "P",
      })],
      agentConfigs: [config],
      extensions: [
        { id: "ext-analyzer", name: "analyzer", description: "Lint/scan tools" },
        { id: "ext-formatter", name: "formatter", description: "Format code" },
        { id: "ext-unused", name: "unused", description: "Not attached" },
      ],
    });

    await page.goto("/agents/ext-agent");

    // Scope the check to the selected-chip container so we don't match the
    // dropdown list items (which also contain the extension names).
    const chips = page.getByTestId("selected-extension-chips");
    await expect(chips).toBeVisible({ timeout: 5000 });
    await expect(chips).toContainText("analyzer");
    await expect(chips).toContainText("formatter");
    await expect(chips).not.toContainText("unused");
  });

  test("agent without extensions shows no chip row (but picker is present)", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-noext",
      name: "noext-agent",
      prompt: "P",
      extensions: [],
    });
    await mockApi({
      agents: [makeAgent({
        name: "noext-agent",
        source: "config",
        id: "cfg-noext",
        prompt: "P",
      })],
      agentConfigs: [config],
    });

    await page.goto("/agents/noext-agent");
    await expect(page.getByText("Tools & Extensions")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("selected-extension-chips")).toHaveCount(0);
  });
});

test.describe("Agent detail page — read-only config summary", () => {
  test("shared read-only agent shows model/provider/temp/maxTokens summary", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-shared-1",
      name: "shared-agent",
      prompt: "Shared prompt",
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.3,
      maxTokens: 2048,
    });
    await mockApi({
      agents: [makeAgent({
        name: "shared-agent",
        source: "config",
        id: "cfg-shared-1",
        prompt: "Shared prompt",
        description: "A shared agent",
        shared: true,
        permission: "read",
      })],
      agentConfigs: [config],
    });

    await page.goto("/agents/shared-agent");

    // The new read-only config summary should render with the saved values.
    const summary = page.getByTestId("agent-config-summary");
    await expect(summary).toBeVisible({ timeout: 5000 });
    await expect(summary).toContainText("openai");
    await expect(summary).toContainText("gpt-4o");
    await expect(summary).toContainText("0.3");
    await expect(summary).toContainText("2048");
  });

  test("shared read-only agent without model fields does not render summary", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-shared-2",
      name: "shared-minimal",
      prompt: "Minimal",
      // No provider/model/temp/maxTokens/extensions
    });
    await mockApi({
      agents: [makeAgent({
        name: "shared-minimal",
        source: "config",
        id: "cfg-shared-2",
        prompt: "Minimal",
        shared: true,
        permission: "read",
      })],
      agentConfigs: [config],
    });

    await page.goto("/agents/shared-minimal");
    await expect(page.getByRole("heading", { name: "shared-minimal" })).toBeVisible();
    // No summary should render.
    await expect(page.getByTestId("agent-config-summary")).toHaveCount(0);
  });
});

test.describe("Team edit page — teamToolScope pre-populated", () => {
  test("team with saved allowed+denied tools shows chips pre-populated on reload", async ({ page, mockApi }) => {
    const memberConfig = makeAgentConfig({
      id: "agent-member",
      name: "member-agent",
      description: "Member",
      prompt: "Do stuff",
      category: "worker",
    });
    const teamConfig = makeAgentConfig({
      id: "team-prepop-1",
      name: "prepop-team",
      description: "Team with scope",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["agent-member"],
        extensions: [],
        members: [{ agentConfigId: "agent-member" }],
        teamToolScope: {
          allowedTools: ["analyzer__scan", "analyzer__lint"],
          deniedTools: ["formatter__format"],
        },
      },
    });
    await mockApi({
      agents: [makeAgent({
        name: "prepop-team",
        source: "config",
        id: "team-prepop-1",
        category: "team",
        prompt: "Coordinate",
      }), makeAgent({
        name: "member-agent",
        source: "config",
        id: "agent-member",
        prompt: "Do stuff",
      })],
      agentConfigs: [teamConfig, memberConfig],
    });

    await page.goto("/agents/prepop-team");

    // The TeamBuilderForm renders team tool scope chips inside ToolSearchPicker
    // (selected-chip row below the input). Both allowed and denied should appear.
    // Chips are rendered via `{#if selected.length > 0 && !open}` so they show on mount.
    await expect(page.getByText("analyzer__scan")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("analyzer__lint")).toBeVisible();
    await expect(page.getByText("formatter__format")).toBeVisible();
  });

  test("team member rows show the member agent's DEFAULT tools (extensions) as pills", async ({ page, mockApi }) => {
    // The member agent has its own extensions attached — those are the tools
    // it brings to the team by default. We want users to see this baseline on
    // the team page, distinct from team-level scope or per-member overrides.
    const memberConfig = makeAgentConfig({
      id: "agent-with-exts",
      name: "toolful-agent",
      description: "Brings its own tools",
      prompt: "P",
      extensions: ["ext-analyzer", "ext-formatter"],
    });
    const teamConfig = makeAgentConfig({
      id: "team-defaults-1",
      name: "defaults-team",
      description: "Shows member defaults",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["agent-with-exts"],
        extensions: [],
        members: [{ agentConfigId: "agent-with-exts" }],
      },
    });
    await mockApi({
      agents: [
        makeAgent({
          name: "defaults-team",
          source: "config",
          id: "team-defaults-1",
          category: "team",
          prompt: "Coordinate",
        }),
        makeAgent({
          name: "toolful-agent",
          source: "config",
          id: "agent-with-exts",
          prompt: "P",
        }),
      ],
      agentConfigs: [teamConfig, memberConfig],
      extensions: [
        { id: "ext-analyzer", name: "analyzer", description: "Scans code" },
        { id: "ext-formatter", name: "formatter", description: "Formats code" },
      ],
    });

    await page.goto("/agents/defaults-team");
    const defaults = page.getByTestId("member-default-tools");
    await expect(defaults).toBeVisible({ timeout: 5000 });
    await expect(defaults).toContainText("analyzer");
    await expect(defaults).toContainText("formatter");
  });

  test("expanding a team member auto-populates override pickers with agent defaults", async ({ page, mockApi }) => {
    // Agent has its own model/provider and attached extensions. When the user
    // expands the member's override panel, the pickers should show those as
    // defaults (display-only — no override is saved until the user interacts).
    const memberConfig = makeAgentConfig({
      id: "agent-defaults",
      name: "default-agent",
      description: "Has its own defaults",
      prompt: "P",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      extensions: ["ext-analyzer"],
    });
    const teamConfig = makeAgentConfig({
      id: "team-defaults-inputs",
      name: "defaults-inputs-team",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["agent-defaults"],
        extensions: [],
        // No per-member override — pickers should fall back to agent defaults.
        members: [{ agentConfigId: "agent-defaults" }],
      },
    });
    await mockApi({
      agents: [
        makeAgent({ name: "defaults-inputs-team", source: "config", id: "team-defaults-inputs", category: "team", prompt: "Coordinate" }),
        makeAgent({ name: "default-agent", source: "config", id: "agent-defaults", prompt: "P" }),
      ],
      agentConfigs: [teamConfig, memberConfig],
      extensions: [
        { id: "ext-analyzer", name: "analyzer", description: "Lint/scan" },
      ],
    });

    await page.goto("/agents/defaults-inputs-team");
    // Expand the member override panel.
    await page.getByText("default-agent", { exact: true }).click();

    // Model & Provider section indicates it's showing the agent default and
    // names the actual model/provider in the same label.
    await expect(page.getByText(/showing agent default \(anthropic\/claude-sonnet-4-5\)/i)).toBeVisible({ timeout: 5000 });

    // Allowed Tools section should indicate defaults are pre-populated.
    await expect(page.getByText("(showing agent defaults — interact to override)")).toBeVisible();

    // Selected tools now render as inline pills inside the combobox chrome
    // (each with an × to remove). Page has multiple tool-picker comboboxes
    // (team-level Allowed/Denied + this member's override) — scope to the
    // member's picker by picking the one filled with agent-default pills.
    const memberToolsCombobox = page
      .getByTestId("tool-picker-combobox")
      .filter({ hasText: "analyzer__scan" });
    await expect(memberToolsCombobox).toBeVisible();
    const pillsInToolsBox = memberToolsCombobox.getByTestId("selected-pill");
    await expect(pillsInToolsBox).toHaveCount(2);
    await expect(memberToolsCombobox).toContainText("analyzer__scan");
    await expect(memberToolsCombobox).toContainText("analyzer__lint");
  });

  test("team member with no extensions shows an actionable 'no extensions attached' hint", async ({ page, mockApi }) => {
    // Reproduces the real-world case: an agent whose extensions were dropped
    // by the pre-fix backend (or that simply has none attached). The row
    // should tell the user exactly what to do instead of rendering nothing.
    const memberConfig = makeAgentConfig({
      id: "bare-agent",
      name: "bare-agent",
      prompt: "P",
      extensions: [],
    });
    const teamConfig = makeAgentConfig({
      id: "team-bare-1",
      name: "bare-team",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["bare-agent"],
        extensions: [],
        members: [{ agentConfigId: "bare-agent" }],
      },
    });
    await mockApi({
      agents: [
        makeAgent({ name: "bare-team", source: "config", id: "team-bare-1", category: "team", prompt: "Coordinate" }),
        makeAgent({ name: "bare-agent", source: "config", id: "bare-agent", prompt: "P" }),
      ],
      agentConfigs: [teamConfig, memberConfig],
    });

    await page.goto("/agents/bare-team");

    // The populated-tools row is absent; the empty-state hint is present.
    await expect(page.getByTestId("member-default-tools")).toHaveCount(0);
    const empty = page.getByTestId("member-default-tools-empty");
    await expect(empty).toBeVisible({ timeout: 5000 });
    await expect(empty).toContainText("no extensions attached");
    // The hint is a clickable link that deep-links to the agent's own editor.
    const link = empty.getByRole("link", { name: /edit bare-agent to add some/i });
    await expect(link).toHaveAttribute("href", "/agents/bare-agent");
  });

  test("team edit page shows member override summary pills when collapsed", async ({ page, mockApi }) => {
    const memberConfig = makeAgentConfig({
      id: "agent-ov",
      name: "override-agent",
      description: "Has overrides",
      prompt: "P",
      category: "worker",
    });
    const teamConfig = makeAgentConfig({
      id: "team-ov-1",
      name: "override-team",
      description: "Team with per-member overrides",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["agent-ov"],
        extensions: [],
        members: [{
          agentConfigId: "agent-ov",
          overrides: {
            toolRestriction: "read-only",
            permissionMode: "yolo",
            allowedTools: ["analyzer__scan", "analyzer__lint"],
            deniedTools: ["formatter__format"],
          },
        }],
      },
    });
    await mockApi({
      agents: [makeAgent({
        name: "override-team",
        source: "config",
        id: "team-ov-1",
        category: "team",
        prompt: "Coordinate",
      }), makeAgent({
        name: "override-agent",
        source: "config",
        id: "agent-ov",
        prompt: "P",
      })],
      agentConfigs: [teamConfig, memberConfig],
    });

    await page.goto("/agents/override-team");

    // summarizeOverrides() emits these labels: "read-only", "yolo",
    // "N allowed", "N denied". All should render as pills on the collapsed row.
    await expect(page.getByText("read-only", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("yolo", { exact: true })).toBeVisible();
    await expect(page.getByText("2 allowed", { exact: true })).toBeVisible();
    await expect(page.getByText("1 denied", { exact: true })).toBeVisible();
  });
});
