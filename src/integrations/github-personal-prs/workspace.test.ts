import { beforeEach, expect, mock, test } from "bun:test";
import type { Database } from "../../db/connection";
import { validateSnapshot } from "./snapshot";

let observed = "stopped";
let createdBinding = "binding";
let imported = 0;
let stopped = 0;
let incusSelections = 0;
const source = validateSnapshot([]);
const status = () => ({ projectId: "project", bindingId: "binding", provider: { generation: 1 },
  privateOwnerOnly: true, initializationState: "pending", privateConversationId: "chat",
  resource: { resourceId: "resource", observedState: observed }, operation: { id: "create", action: "create", state: "admitted" } });
mock.module("../../runtime/sandbox/controller", () => ({ getSandboxController: () => ({
  getProjectSandboxStatus: async () => status(),
  runPrivateWorkspaceImport: async (_user: string, _project: string, _operation: string, work: () => Promise<void>) => work(),
  executeAdmittedLocalSandboxOperation: async () => ({ ...status(), bindingId: createdBinding }),
  requestSandboxAction: async () => { stopped++; observed = "stopped"; return { id: "stop" }; },
}) }));
mock.module("./provider-transfer", () => ({ importSnapshotToSandbox: async () => { imported++; }, exportSnapshotFromSandbox: async () => source }));
mock.module("./incus-workspace-service", () => ({ incusPersonalPrWorkspace: () => { incusSelections++; return { marker: "incus" }; } }));
const { getPersonalPrWorkspace, legacyPersonalPrWorkspace } = await import("./workspace");
const database = (value: unknown) => ({ execute: async () => value }) as unknown as Database;
beforeEach(() => { observed = "stopped"; createdBinding = "binding"; imported = 0; stopped = 0; incusSelections = 0; });

test("durable import authority selects Incus; valid absent or legacy authority selects existing controller", async () => {
  const selected = await getPersonalPrWorkspace("owner", "project", database({ rows: [{ workspace_authority: { kind: "incus" } }] }));
  expect(selected).toEqual({ marker: "incus" });
  expect(incusSelections).toBe(1);
  for (const value of [{ rows: [] }, { rows: [{ workspace_authority: null }] }]) {
    expect((await (await getPersonalPrWorkspace("owner", "project", database(value))).status()).kind).toBe("legacy");
  }
  await expect(getPersonalPrWorkspace("owner", "project", database({}))).rejects.toThrow();
});

test("legacy import keeps create, transfer and durable completion inside existing private callback", async () => {
  const port = legacyPersonalPrWorkspace("owner", "project");
  const initial = await port.status();
  let completed = false;
  await port.importSnapshot("operation", initial, source, async current => { completed = true; expect(current.bindingId).toBe("binding"); });
  expect(imported).toBe(1); expect(completed).toBe(true);
  expect(await port.capture("chat")).toBe(source);
  expect((await port.forRun("chat")).kind).toBe("legacy");
});

test("legacy changed resource fails before source import", async () => {
  const port = legacyPersonalPrWorkspace("owner", "project");
  const initial = await port.status();
  createdBinding = "other";
  await expect(port.importSnapshot("operation", initial, source, async () => { throw new Error("must not complete"); })).rejects.toThrow("could not be created");
  expect(imported).toBe(0);
});

test("legacy review stops running guest once and keeps stopped export semantics", async () => {
  const port = legacyPersonalPrWorkspace("owner", "project");
  observed = "running";
  expect(port.canReview(await port.status())).toBe(false);
  expect(port.canReview(await port.prepareReview())).toBe(true);
  expect(port.canReview(await port.prepareReview())).toBe(true);
  expect(stopped).toBe(1);
});
