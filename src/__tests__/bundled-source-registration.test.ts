import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { listFirstPartyExtensionSources } from "../../scripts/migrate-extension-v4";

const stage = mock(async (_entries: readonly { name: string; path: string }[]) => {});
mock.module("../extensions/bundled-bootstrap", () => ({ stageBundledExtensionSources: stage }));
const { ensureBundledExtensions, resolveBundledExtensions } = await import("../extensions/bundled");
const { getProjectRoot } = await import("../extensions/project-root");
const sources = await listFirstPartyExtensionSources(getProjectRoot());
const previous = process.env.EZCORP_DISABLE_AI_KIT;
beforeEach(() => { stage.mockClear(); delete process.env.EZCORP_DISABLE_AI_KIT; });
afterAll(() => {
  if (previous === undefined) delete process.env.EZCORP_DISABLE_AI_KIT;
  else process.env.EZCORP_DISABLE_AI_KIT = previous;
  restoreModuleMocks();
});

for (const entry of resolveBundledExtensions({})) test(`${entry.name}: startup stages the exact reviewed source inventory`, async () => {
  await ensureBundledExtensions();
  expect(stage).toHaveBeenCalledTimes(1);
  const selected = stage.mock.calls[0]![0].filter((candidate) => candidate.name === entry.name);
  expect(selected).toHaveLength(1);
  expect(selected[0]?.path).toBe(sources.find((source) => source.name === entry.name)?.directory);
});

test("the ai-kit operator opt-out prevents source staging without changing other entries", async () => {
  process.env.EZCORP_DISABLE_AI_KIT = "1";
  await ensureBundledExtensions();
  const selected = stage.mock.calls[0]![0];
  expect(selected.some((entry) => entry.name === "ai-kit")).toBe(false);
  expect(selected.map((entry) => entry.name)).toEqual(resolveBundledExtensions({}).filter((entry) => entry.name !== "ai-kit").map((entry) => entry.name));
});
