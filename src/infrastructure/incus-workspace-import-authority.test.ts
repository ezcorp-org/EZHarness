import { expect, test } from "bun:test";
import type { Database } from "../db/connection";
import { assertIncusWorkspaceImportAuthority, recordIncusWorkspaceImportResult, withIncusWorkspaceImportAuthority } from "./incus-workspace-import-authority";

const identity = { ownerId: "owner", projectId: "project", operationId: "import" };
const input = { userId: "owner", projectId: "project", action: "file.writeAtomic" as const, payload: { path: "src/a.txt" } };
const row = { owner_id: "owner", state: "importing", operation_id: "import", workspace_authority: { kind: "incus" }, member_count: 1, owner_member: true };
function database(value: unknown): Database {
  return { execute: async () => value } as unknown as Database;
}
const permits = (action: string, payload: Readonly<Record<string, unknown>>) => action === "file.writeAtomic" && payload.path === "src/a.txt";

test("malformed authority reads fail closed; valid absence and legacy remain unchanged", async () => {
  for (const malformed of [undefined, null, {}, { rows: null }]) {
    await expect(assertIncusWorkspaceImportAuthority(input, database(malformed))).rejects.toThrow();
  }
  await assertIncusWorkspaceImportAuthority(input, database({ rows: [] }));
  await assertIncusWorkspaceImportAuthority(input, database({ rows: [{ ...row, workspace_authority: null }] }));
});

test("exact active host import can write only its fixed path", async () => {
  await expect(assertIncusWorkspaceImportAuthority(input, database({ rows: [row] }))).rejects.toThrow("must finish");
  await withIncusWorkspaceImportAuthority(identity, permits, async () => {
    await assertIncusWorkspaceImportAuthority(input, database({ rows: [row] }));
    await expect(assertIncusWorkspaceImportAuthority({ ...input, payload: { path: "other" } }, database({ rows: [row] }))).rejects.toThrow();
    await expect(assertIncusWorkspaceImportAuthority(input, database({ rows: [{ ...row, operation_id: "second" }] }))).rejects.toThrow();
  });
});

test("ready private import keeps owner and sole membership checks", async () => {
  for (const changed of [{ ...row, state: "ready", owner_id: "other" }, { ...row, state: "ready", member_count: 2 }, { ...row, state: "ready", owner_member: false }]) {
    await expect(assertIncusWorkspaceImportAuthority(input, database({ rows: [changed] }))).rejects.toThrow();
  }
  await assertIncusWorkspaceImportAuthority(input, database({ rows: [{ ...row, state: "ready" }] }));
});

test("partial and unknown import cannot use even matching internal authority", async () => {
  await withIncusWorkspaceImportAuthority(identity, permits, async () => {
    for (const state of ["failed", "unknown"]) await expect(assertIncusWorkspaceImportAuthority(input, database({ rows: [{ ...row, state }] }))).rejects.toThrow();
  });
});

test("detached asynchronous work cannot retain import authority after callback finishes", async () => {
  const gate = Promise.withResolvers<void>();
  let detached: Promise<void> | undefined;
  await withIncusWorkspaceImportAuthority(identity, permits, async () => {
    detached = gate.promise.then(() => assertIncusWorkspaceImportAuthority(input, database({ rows: [row] })));
  });
  gate.resolve();
  await expect(detached!).rejects.toThrow("must finish");
});

test("a fresh dispatch check observes an import admitted while a native call waited", async () => {
  let current: unknown = { rows: [] };
  const db = { execute: async () => current } as unknown as Database;
  await assertIncusWorkspaceImportAuthority(input, db);
  current = { rows: [row] };
  await expect(assertIncusWorkspaceImportAuthority(input, db)).rejects.toThrow("must finish");
});


test("validated reply observation is limited to the same active import and fixed action", async () => {
  const observed: unknown[] = [];
  const record = (value = input) => recordIncusWorkspaceImportResult(value, { ok: true, processId: "process" });
  record();
  await withIncusWorkspaceImportAuthority(identity, permits, async () => {
    record({ ...input, userId: "other" });
    record({ ...input, projectId: "other" });
    record({ ...input, payload: { path: "other" } });
    expect(observed).toEqual([]);
    record();
  }, (action, payload, result) => observed.push({ action, payload, result }));
  record();
  expect(observed).toEqual([{ action: input.action, payload: input.payload, result: { ok: true, processId: "process" } }]);
});

test("ambiguous authority and an absent principal cannot become an import permit", async () => {
  await expect(assertIncusWorkspaceImportAuthority(input, database({ rows: [row, row] }))).rejects.toThrow("ambiguous");
  await expect(assertIncusWorkspaceImportAuthority({ ...input, userId: undefined }, database({ rows: [row] }))).rejects.toThrow("another user");
  await withIncusWorkspaceImportAuthority({ ...identity, projectId: "different" }, permits, async () => {
    await expect(assertIncusWorkspaceImportAuthority(input, database({ rows: [row] }))).rejects.toThrow("must finish");
  });
});
