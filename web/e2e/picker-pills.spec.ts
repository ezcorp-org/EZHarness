import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeAgentConfig, makeMode } from "./fixtures/data.js";

// Pills-with-× coverage for every combobox picker we use. Exercises:
//   - pre-populated selected pills render inside the combobox chrome
//   - clicking × removes the item (multi-select) or clears (single-select)
//   - the underlying onchange / onselect / onclear fire correctly
//
// The Agent editor and Team editor are the most representative surfaces
// because they exercise both multi-select (Extensions, Tools) and
// single-select (Model) pickers in one place.

test.describe("ExtensionSearchPicker — pills on the agent edit page", () => {
  test("pre-selected extensions render as pills with ×, click removes them", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-exts",
      name: "pills-agent",
      prompt: "P",
      extensions: ["ext-analyzer", "ext-formatter"],
    });
    await mockApi({
      agents: [makeAgent({ name: "pills-agent", source: "config", id: "cfg-exts", prompt: "P" })],
      agentConfigs: [config],
      extensions: [
        { id: "ext-analyzer", name: "analyzer", description: "Lint/scan" },
        { id: "ext-formatter", name: "formatter", description: "Format" },
      ],
    });

    await page.goto("/agents/pills-agent");

    // Pills render inside the combobox chrome (not a separate chip row).
    const combobox = page.getByTestId("extension-picker-combobox");
    await expect(combobox).toBeVisible({ timeout: 5000 });
    const pills = combobox.getByTestId("selected-pill");
    await expect(pills).toHaveCount(2);
    await expect(combobox).toContainText("analyzer");
    await expect(combobox).toContainText("formatter");

    // Remove the first pill (analyzer) via its ×. The remove handler fires
    // on `mousedown` (SelectedPill.handleMouseDown); a full `.click()` also
    // triggers svelte-dnd-action's pointer-drag init on the chip row, which
    // re-syncs the items and swallows the removal. Dispatching mousedown
    // directly matches the handler without starting a drag.
    const analyzerPill = combobox.getByTestId("selected-pill").filter({ hasText: "analyzer" });
    await analyzerPill.getByRole("button", { name: /remove analyzer/i }).dispatchEvent("mousedown");

    // Pill count drops to 1 and the remaining pill is formatter.
    await expect(combobox.getByTestId("selected-pill")).toHaveCount(1);
    await expect(combobox).not.toContainText("analyzer");
    await expect(combobox).toContainText("formatter");
  });

  test("no selected → no pill, just placeholder input", async ({ page, mockApi }) => {
    const config = makeAgentConfig({ id: "cfg-empty", name: "empty-agent", prompt: "P", extensions: [] });
    await mockApi({
      agents: [makeAgent({ name: "empty-agent", source: "config", id: "cfg-empty", prompt: "P" })],
      agentConfigs: [config],
    });

    await page.goto("/agents/empty-agent");
    const combobox = page.getByTestId("extension-picker-combobox");
    await expect(combobox).toBeVisible({ timeout: 5000 });
    await expect(combobox.getByTestId("selected-pill")).toHaveCount(0);
  });
});

test.describe("ToolSearchPicker — pills on the team edit page", () => {
  test("team tool scope pre-selected tools render as pills with ×, removing a pill updates selection", async ({ page, mockApi }) => {
    const member = makeAgentConfig({ id: "m-1", name: "m1", prompt: "P" });
    const team = makeAgentConfig({
      id: "team-pills",
      name: "pills-team",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["m-1"],
        extensions: [],
        members: [{ agentConfigId: "m-1" }],
        teamToolScope: {
          allowedTools: ["analyzer__scan", "analyzer__lint", "formatter__format"],
          deniedTools: ["shell__bash"],
        },
      },
    });
    await mockApi({
      agents: [
        makeAgent({ name: "pills-team", source: "config", id: "team-pills", category: "team", prompt: "Coordinate" }),
        makeAgent({ name: "m1", source: "config", id: "m-1", prompt: "P" }),
      ],
      agentConfigs: [team, member],
    });

    await page.goto("/agents/pills-team");

    // There are two tool-picker comboboxes at team level (Allowed + Denied).
    // Scope each by text content.
    const allowBox = page.getByTestId("tool-picker-combobox").filter({ hasText: "analyzer__scan" });
    await expect(allowBox.getByTestId("selected-pill")).toHaveCount(3);
    await expect(allowBox).toContainText("analyzer__scan");
    await expect(allowBox).toContainText("analyzer__lint");
    await expect(allowBox).toContainText("formatter__format");

    const denyBox = page.getByTestId("tool-picker-combobox").filter({ hasText: "shell__bash" });
    await expect(denyBox.getByTestId("selected-pill")).toHaveCount(1);

    // Remove formatter__format from the Allowed list via its × button.
    await allowBox
      .getByTestId("selected-pill")
      .filter({ hasText: "formatter__format" })
      .getByRole("button", { name: /remove formatter__format/i })
      .click();
    await expect(allowBox.getByTestId("selected-pill")).toHaveCount(2);
    await expect(allowBox).not.toContainText("formatter__format");
  });
});

test.describe("ModelSearchPicker — single pill with × clears selection", () => {
  test("pre-selected model renders as a pill; × clears when onclear is wired", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-model",
      name: "model-agent",
      prompt: "P",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    await mockApi({
      agents: [makeAgent({ name: "model-agent", source: "config", id: "cfg-model", prompt: "P" })],
      agentConfigs: [config],
    });

    await page.goto("/agents/model-agent");
    const combobox = page.getByTestId("model-picker-combobox");
    await expect(combobox).toBeVisible({ timeout: 5000 });
    // Single pill shows the current model name.
    const pill = combobox.getByTestId("selected-pill");
    await expect(pill).toHaveCount(1);
    await expect(pill).toContainText("claude-sonnet-4-5");

    // × fires AgentConfigForm's onclear — which sets to CURRENT_MODEL_SENTINEL.
    // The pill is then re-rendered with the sentinel's display text
    // ("Current Chat Model"), not fully removed — this is the caller's
    // chosen "clear" semantic. Verify the label swaps.
    await pill.getByRole("button", { name: /remove claude-sonnet-4-5/i }).click();
    await expect(combobox.getByTestId("selected-pill")).toContainText("Current Chat Model");
  });
});

test.describe("ModeSearchPicker — single pill clears via × to null", () => {
  // Mode picker is used in per-member team override panel. We set a modeId
  // via mocks and assert the pill renders; × calls selectMode(null) which
  // removes the override entirely, hiding the pill.
  test("pre-selected mode renders as a pill; × clears it", async ({ page, mockApi }) => {
    const planMode = makeMode({
      id: "mode-plan",
      name: "Plan",
      slug: "plan",
      description: "Plan only",
      toolRestriction: "read-only",
      builtin: true,
    });
    const member = makeAgentConfig({ id: "m-1", name: "m1", prompt: "P" });
    const team = makeAgentConfig({
      id: "team-mode",
      name: "mode-team",
      prompt: "Coordinate",
      category: "team",
      references: {
        agents: ["m-1"],
        extensions: [],
        members: [{ agentConfigId: "m-1", overrides: { modeId: "mode-plan" } }],
      },
    });
    await mockApi({
      agents: [
        makeAgent({ name: "mode-team", source: "config", id: "team-mode", category: "team", prompt: "Coordinate" }),
        makeAgent({ name: "m1", source: "config", id: "m-1", prompt: "P" }),
      ],
      agentConfigs: [team, member],
      modes: [planMode],
    });

    await page.goto("/agents/mode-team");
    await page.getByText("m1", { exact: true }).click();

    const modeBox = page.getByTestId("mode-picker-combobox");
    await expect(modeBox).toBeVisible({ timeout: 5000 });
    const pill = modeBox.getByTestId("selected-pill");
    await expect(pill).toHaveCount(1);
    await expect(pill).toContainText("Plan");

    // Clicking × clears modeId → no pill.
    await pill.getByRole("button", { name: /remove/i }).click();
    await expect(modeBox.getByTestId("selected-pill")).toHaveCount(0);
  });
});

test.describe("SelectedPill — shared component contract", () => {
  test("every pill exposes an aria-labelled × button (accessibility)", async ({ page, mockApi }) => {
    // Any picker with pre-selected pills is enough to exercise the button.
    const config = makeAgentConfig({
      id: "cfg-a11y",
      name: "a11y-agent",
      prompt: "P",
      extensions: ["ext-analyzer", "ext-formatter"],
    });
    await mockApi({
      agents: [makeAgent({ name: "a11y-agent", source: "config", id: "cfg-a11y", prompt: "P" })],
      agentConfigs: [config],
      extensions: [
        { id: "ext-analyzer", name: "analyzer", description: "" },
        { id: "ext-formatter", name: "formatter", description: "" },
      ],
    });
    await page.goto("/agents/a11y-agent");

    const pills = page.getByTestId("extension-picker-combobox").getByTestId("selected-pill");
    await expect(pills).toHaveCount(2);
    // Every pill contains a button whose accessible name includes "Remove <label>".
    await expect(pills.first().getByRole("button", { name: /remove analyzer/i })).toBeVisible();
    await expect(pills.last().getByRole("button", { name: /remove formatter/i })).toBeVisible();
  });

  test("× activates via keyboard (Enter)", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-kbd",
      name: "kbd-agent",
      prompt: "P",
      extensions: ["ext-analyzer"],
    });
    await mockApi({
      agents: [makeAgent({ name: "kbd-agent", source: "config", id: "cfg-kbd", prompt: "P" })],
      agentConfigs: [config],
      extensions: [{ id: "ext-analyzer", name: "analyzer", description: "" }],
    });
    await page.goto("/agents/kbd-agent");

    const combobox = page.getByTestId("extension-picker-combobox");
    const removeBtn = combobox.getByRole("button", { name: /remove analyzer/i });
    await removeBtn.focus();
    await page.keyboard.press("Enter");

    await expect(combobox.getByTestId("selected-pill")).toHaveCount(0);
  });
});

test.describe("Combobox layout — input width preserved with pills inside", () => {
  // Regression for the user report "the input now moves to the right of the
  // pills". The fix stacks pills on their own row above the input inside the
  // same chrome, so the input's width does NOT shrink as pills are added.
  test("input width stays equal whether 0 or many pills are selected", async ({ page, mockApi }) => {
    // Two agents on the same page — one with empty extensions, one with 3 —
    // both inside the same layout so we can compare their picker input widths.
    const empty = makeAgentConfig({ id: "empty", name: "empty-agent", prompt: "P", extensions: [] });
    const many = makeAgentConfig({
      id: "many",
      name: "many-agent",
      prompt: "P",
      extensions: ["ext-1", "ext-2", "ext-3"],
    });
    await mockApi({
      agents: [
        makeAgent({ name: "empty-agent", source: "config", id: "empty", prompt: "P" }),
        makeAgent({ name: "many-agent", source: "config", id: "many", prompt: "P" }),
      ],
      agentConfigs: [empty, many],
      extensions: [
        { id: "ext-1", name: "one-extension", description: "" },
        { id: "ext-2", name: "two-extension", description: "" },
        { id: "ext-3", name: "three-extension", description: "" },
      ],
    });

    // Measure the picker's input width for the empty agent.
    await page.goto("/agents/empty-agent");
    const emptyBox = page.getByTestId("extension-picker-combobox");
    await expect(emptyBox).toBeVisible();
    const emptyInput = emptyBox.locator("input[role='combobox']");
    const emptyBB = await emptyInput.boundingBox();

    // Measure the same picker's input width for the many-pills agent.
    await page.goto("/agents/many-agent");
    const manyBox = page.getByTestId("extension-picker-combobox");
    await expect(manyBox).toBeVisible();
    await expect(manyBox.getByTestId("selected-pill")).toHaveCount(3);
    const manyInput = manyBox.locator("input[role='combobox']");
    const manyBB = await manyInput.boundingBox();

    // Width must be identical within 1px. If a future refactor reverts to
    // inline flex pills, the input will shrink and this diff will spike.
    expect(emptyBB).not.toBeNull();
    expect(manyBB).not.toBeNull();
    expect(Math.abs(emptyBB!.width - manyBB!.width)).toBeLessThanOrEqual(1);
  });
});

test.describe("Combobox pill semantics — add & remove lifecycle", () => {
  test("removing the last pill hides the pill row entirely", async ({ page, mockApi }) => {
    const config = makeAgentConfig({
      id: "cfg-last",
      name: "last-agent",
      prompt: "P",
      extensions: ["ext-only"],
    });
    await mockApi({
      agents: [makeAgent({ name: "last-agent", source: "config", id: "cfg-last", prompt: "P" })],
      agentConfigs: [config],
      extensions: [{ id: "ext-only", name: "only", description: "" }],
    });
    await page.goto("/agents/last-agent");

    const combobox = page.getByTestId("extension-picker-combobox");
    await expect(combobox.getByTestId("selected-pill")).toHaveCount(1);
    // `selected-extension-chips` is the pills-row container — only rendered
    // when there's at least one pill.
    await expect(combobox.getByTestId("selected-extension-chips")).toHaveCount(1);

    // mousedown, not click — see the drag-init note on the analyzer test.
    await combobox.getByRole("button", { name: /remove only/i }).dispatchEvent("mousedown");

    // After removing the last pill, both the pill and its row container are gone.
    await expect(combobox.getByTestId("selected-pill")).toHaveCount(0);
    await expect(combobox.getByTestId("selected-extension-chips")).toHaveCount(0);
  });

  test("picking an option from the dropdown adds a pill", async ({ page, mockApi }) => {
    const config = makeAgentConfig({ id: "cfg-add", name: "add-agent", prompt: "P", extensions: [] });
    await mockApi({
      agents: [makeAgent({ name: "add-agent", source: "config", id: "cfg-add", prompt: "P" })],
      agentConfigs: [config],
      extensions: [
        { id: "ext-add", name: "addable", description: "desc" },
      ],
    });
    await page.goto("/agents/add-agent");
    const combobox = page.getByTestId("extension-picker-combobox");
    await expect(combobox.getByTestId("selected-pill")).toHaveCount(0);

    // Open the picker and select the "addable" option.
    await combobox.locator("input[role='combobox']").click();
    await page.getByRole("option", { name: /addable/i }).click();

    await expect(combobox.getByTestId("selected-pill")).toHaveCount(1);
    await expect(combobox.getByTestId("selected-pill")).toContainText("addable");
  });

  test("long pill labels don't break the layout (truncate within pill)", async ({ page, mockApi }) => {
    const longName = "a-very-long-extension-name-that-would-normally-overflow-a-single-line";
    const config = makeAgentConfig({
      id: "cfg-long",
      name: "long-agent",
      prompt: "P",
      extensions: ["ext-long"],
    });
    await mockApi({
      agents: [makeAgent({ name: "long-agent", source: "config", id: "cfg-long", prompt: "P" })],
      agentConfigs: [config],
      extensions: [{ id: "ext-long", name: longName, description: "" }],
    });
    await page.goto("/agents/long-agent");

    const combobox = page.getByTestId("extension-picker-combobox");
    const pill = combobox.getByTestId("selected-pill");
    await expect(pill).toHaveCount(1);
    // Pill width must not exceed the combobox width (proving the layout
    // contains overflowing labels — `truncate` on the label span).
    const pillBB = await pill.boundingBox();
    const boxBB = await combobox.boundingBox();
    expect(pillBB).not.toBeNull();
    expect(boxBB).not.toBeNull();
    expect(pillBB!.width).toBeLessThanOrEqual(boxBB!.width);
  });
});
