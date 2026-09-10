import type { Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeAgent, makeAgentConfig, makeConversation, makeExtension, makeMode, makeProject } from "./fixtures/data.js";
import { seedTaskSnapshot } from "./fixtures/task-seed.js";

// Each real picker entry point is opened once per viewport. Mobile cases
// cover all three native dismissal paths in the same page to avoid 27 extra
// application startups. Every reopen must render its body before dismissal.
const mobile = { width: 375, height: 812 };
const desktop = { width: 1280, height: 800 };
const project = makeProject({ id: "picker-project", name: "Picker project" });
const conversation = makeConversation({ id: "picker-conversation", projectId: project.id });
const agent = makeAgentConfig({ id: "picker-agent", name: "Picker agent" });
const team = makeAgentConfig({ id: "picker-team", name: "Picker team", category: "team", references: { agents: [agent.id], extensions: [], members: [{ agentConfigId: agent.id }] } });
const extension = makeExtension({ id: "picker-extension", name: "Picker extension" });

type Picker = {
  name: string;
  path: string;
  trigger: string;
  prepare?: (page: Page) => Promise<void>;
  content: (page: Page) => Locator;
};
const configure = async (page: Page) => { await page.getByRole("button", { name: "Configure", exact: true }).click(); };
const searches: Record<string, { query: string; label: string; selectedLabel: string; multiple?: boolean }> = {
  "agent-search": { query: "Picker", label: "Picker agent", selectedLabel: "Picker agent" },
  "extension-search": { query: "Picker", label: "Picker extension", selectedLabel: "Picker extension", multiple: true },
  "model-search": { query: "GPT", label: "GPT-4o", selectedLabel: "GPT-4o" },
  "mode-search": { query: "Review", label: "Review", selectedLabel: "Review" },
  "tool-search": { query: "scan", label: "scan", selectedLabel: "analyzer__scan", multiple: true },
};
const pickers: Picker[] = [
  { name: "assignment", path: `/project/${project.id}/chat/${conversation.id}`, trigger: "open-assignment-picker", prepare: async page => {
    await seedTaskSnapshot(page, { conversationId: conversation.id, tasks: [{ id: "picker-task", title: "Assign this task", description: "", status: "pending", priority: 0, subtasks: [], createdAt: "2026-01-01T00:00:00Z" }] });
    await page.getByText("Assign this task", { exact: true }).hover();
  }, content: page => page.getByPlaceholder("Search agents...", { exact: true }) },
  { name: "agent-search", path: "/agents/new?type=team", trigger: "open-agent-picker", content: page => page.getByRole("listbox", { name: "Available agents", exact: true }) },
  { name: "extension-attach", path: "/agents/new", trigger: "open-extension-attach-picker", prepare: configure, content: page => page.getByTestId("extension-attach-picker-card") },
  { name: "extension-search", path: "/agents/new", trigger: "open-extension-search-picker", prepare: configure, content: page => page.getByRole("listbox", { name: "Available extensions", exact: true }) },
  { name: "file", path: "/new-project", trigger: "open-file-picker", content: page => page.getByPlaceholder("/app/web/.ezcorp/projects/my-project", { exact: true }) },
  { name: "model-search", path: "/agents/new", trigger: "open-model-search-picker", prepare: configure, content: page => page.getByRole("listbox", { name: "Available models", exact: true }) },
  { name: "mode-search", path: `/agents/${encodeURIComponent(team.name)}`, trigger: "open-mode-search-picker", prepare: async page => { await page.getByText(agent.name, { exact: true }).click(); }, content: page => page.getByRole("listbox", { name: "Available modes", exact: true }) },
  { name: "project", path: "/memories", trigger: "open-project-picker", prepare: async page => { await page.getByTestId("add-memory-toggle").click(); }, content: page => page.getByTestId(`project-picker-item-${project.id}`) },
  { name: "tool-search", path: "/agents/new?type=team", trigger: "open-tool-search-picker", content: page => page.getByRole("listbox", { name: "Available tools", exact: true }) },
];

test.beforeEach(async ({ mockApi }) => {
  await mockApi({ projects: [project], conversations: [conversation], agentConfigs: [agent, team],
    agents: [agent, team].map(config => makeAgent({ id: config.id, name: config.name, prompt: config.prompt, category: config.category ?? undefined, source: "config" })),
    extensions: [extension], modes: [makeMode({ id: "picker-mode", name: "Review", slug: "review" })],
  });
});

async function openPicker(page: Page, picker: Picker, first = false) {
  if (first) {
    await page.goto(picker.path);
    await picker.prepare?.(page);
  }
  const trigger = page.getByTestId(picker.trigger).first();
  // FilePicker is inline on desktop. All other triggers are buttons/inputs.
  const inlineFileInput = trigger.locator("input");
  if (picker.name === "file" && await inlineFileInput.count()) await inlineFileInput.click();
  else await trigger.click();
  await expect(picker.content(page)).toBeVisible();
}

for (const picker of pickers) {
  test(`${picker.name}: mobile dialog supports Close, Escape, and backdrop dismissal${picker.name === "extension-attach" ? " @evidence" : ""}`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile);
    for (const [index, dismiss] of ["close", "escape", "backdrop"].entries()) {
      await openPicker(page, picker, index === 0);
      const sheet = page.getByTestId("bottom-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute("role", "dialog");
      await expect(sheet).toHaveAttribute("aria-modal", "true");
      const panel = page.getByTestId("bottom-sheet-panel");
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(mobile.width);
      if (picker.name === "extension-attach") {
        await expect(sheet).toHaveAttribute("aria-label", "Attach extensions");
        await expect(sheet.getByRole("heading", { name: "Attach extensions", exact: true })).toHaveCount(0);
        await expect(sheet.getByRole("button", { name: "Close picker", exact: true })).toHaveCount(1);
        await expect(page.getByTestId("extension-attach-picker-card")).toContainText("1 tool");
        await expect(page.getByTestId("extension-attach-picker-card")).not.toContainText("1 tools");
      }
      if (index === 0) await captureEvidence(page, testInfo, `picker-${picker.name}-mobile`);
      if (dismiss === "close") await sheet.getByRole("button", { name: "Close", exact: true }).click();
      else if (dismiss === "escape") await page.keyboard.press("Escape");
      else await sheet.locator(':scope > button[aria-label="Close picker"]').click({ position: { x: 10, y: 10 } });
      await expect(sheet).toHaveCount(0);
    }
    const search = searches[picker.name];
    if (search) {
      await openPicker(page, picker);
      const sheet = page.getByTestId("bottom-sheet");
      const input = sheet.getByRole("combobox");
      // The native modal focus trap must leave search available in the sheet.
      await expect(input).toHaveCount(1);
      await input.fill("no-picker-results-xyz");
      await expect(sheet.getByText(search.label, { exact: true })).toHaveCount(0);
      await input.fill(search.query);
      const result = sheet.getByRole("option").filter({ has: page.getByText(search.label, { exact: true }) });
      await expect(result).toHaveCount(1);
      await captureEvidence(page, testInfo, `picker-${picker.name}-mobile-search`);
      await result.getByRole("button").first().click();
      if (search.multiple) {
        await expect(result).toHaveAttribute("aria-selected", "true");
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
      }
      await expect(sheet).toHaveCount(0);
      await expect(page.getByText(search.selectedLabel, { exact: true }).first()).toBeVisible();
    }
  });

  test(`${picker.name}: desktop opens its usable body without a bottom sheet`, async ({ page }) => {
    await page.setViewportSize(desktop);
    await openPicker(page, picker, true);
    await expect(page.getByTestId("bottom-sheet")).toHaveCount(0);
    await expect(picker.content(page)).toBeVisible();
  });
}

test("mobile sheet retains safe-area padding and accessible dialog controls", async ({ page }, testInfo) => {
  await page.setViewportSize(mobile);
  await openPicker(page, pickers.find(picker => picker.name === "file")!, true);
  const panel = page.getByTestId("bottom-sheet-panel");
  await expect(panel).toHaveAttribute("style", /padding-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
  const padding = await panel.evaluate(element => getComputedStyle(element).paddingBottom);
  expect(Number.parseFloat(padding)).toBeGreaterThanOrEqual(0);
  const close = page.getByTestId("bottom-sheet").getByRole("button", { name: "Close", exact: true });
  const box = await close.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const accessibility = await new AxeBuilder({ page }).include('[data-testid="bottom-sheet"]').analyze();
  expect(accessibility.violations).toEqual([]);
  await captureEvidence(page, testInfo, "picker-safe-area-accessibility");
});
