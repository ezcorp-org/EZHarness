import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { listFirstPartyExtensionSources } from "../../scripts/migrate-extension-v4";

const stage = mock(async (_entries: readonly { name: string; path: string }[]) => {});
mock.module("../extensions/bundled-bootstrap", () => ({ stageBundledExtensionSources: stage }));
// Boot is the first of the two sites that reconcile conversation wiring
// (activation is the other). Stubbing it here keeps this DB-free suite
// DB-free AND pins the call: a conversation created while a bundled
// extension was disabled only gets its `conversation_extensions` row
// because startup reconciles, so dropping the call would silently
// re-open that gap.
const reconcile = mock(async () => 0);
mock.module("../extensions/auto-wire-bundled", () => ({ reconcileBundledConversationWiring: reconcile }));
const { ensureBundledExtensions, resolveBundledExtensions } = await import("../extensions/bundled");
const { getProjectRoot } = await import("../extensions/project-root");
const sources = await listFirstPartyExtensionSources(getProjectRoot());
const previous = process.env.EZCORP_DISABLE_AI_KIT;
beforeEach(() => { stage.mockClear(); reconcile.mockClear(); delete process.env.EZCORP_DISABLE_AI_KIT; });
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
  const source = sources.find((source) => source.name === entry.name);
  expect(source).toBeDefined();
  expect(selected[0]?.path).toBe(source!.directory);
});

test("startup reconciles bundled conversation wiring after staging the sources", async () => {
  await ensureBundledExtensions();
  expect(reconcile).toHaveBeenCalledTimes(1);
  // Order matters: staging is what can newly enable a bundled extension,
  // so the reconcile has to read the registry after it.
  expect(reconcile.mock.invocationCallOrder[0]!).toBeGreaterThan(stage.mock.invocationCallOrder[0]!);
});

test("the ai-kit operator opt-out prevents source staging without changing other entries", async () => {
  process.env.EZCORP_DISABLE_AI_KIT = "1";
  await ensureBundledExtensions();
  const selected = stage.mock.calls[0]![0];
  expect(selected.some((entry) => entry.name === "ai-kit")).toBe(false);
  expect(selected.map((entry) => entry.name)).toEqual(resolveBundledExtensions({}).filter((entry) => entry.name !== "ai-kit").map((entry) => entry.name));
});
