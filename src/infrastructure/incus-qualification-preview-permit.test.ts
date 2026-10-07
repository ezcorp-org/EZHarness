import { expect, test } from "bun:test";
import { sandboxWorkspaceTarget, type SandboxWorkspaceBackend } from "../runtime/workspaces/target";
import { registerClaimedQualificationPreview } from "./incus-qualification-preview-permit";

test("a preview permit checks the claimed fixture on every request and expires", async () => {
  const binding = { projectId: "project", workspaceId: "fixture", connectionId: "connection",
    providerId: "incus", generation: 1, presetId: "incus-compose-v1",
    releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
    effectiveSettingsDigest: "c".repeat(64) };
  const target = sandboxWorkspaceTarget(binding, { previews: {
    open: async () => {}, serve: async () => new Response("ok"), close: async () => {},
  } } as SandboxWorkspaceBackend);
  let clock = 1000;
  let state = { runId: "run", nonce: "nonce", state: "CLAIMED", fixtureOperationId: "qual-primary-run",
    fixtureBindingId: "fixture", fixtureGeneration: 1, connectionRevision: 1,
    releaseDigest: binding.releaseDigest, binding, running: true };
  let resolve: (() => Promise<typeof target | undefined>) | undefined;
  let disposed = false;
  const dispose = await registerClaimedQualificationPreview({
    key: { previewId: "preview", userId: "owner", conversationId: "conversation", binding, targetPort: 4173 },
    runId: "run", nonce: "nonce", fixtureOperationId: "qual-primary-run", connectionRevision: 1,
    releaseDigest: binding.releaseDigest, expiresAtMs: 2000, target,
  }, { now: () => clock, readCurrent: async () => state,
    register: (_key, callback) => { resolve = callback; return () => { disposed = true; }; } });
  expect(await resolve!()).toBe(target);
  state = { ...state, nonce: "wrong" };
  expect(await resolve!()).toBeUndefined();
  state = { ...state, nonce: "nonce", running: false };
  expect(await resolve!()).toBeUndefined();
  state = { ...state, running: true, fixtureGeneration: 2 };
  expect(await resolve!()).toBeUndefined();
  state = { ...state, fixtureGeneration: 1 };
  clock = 2000;
  expect(await resolve!()).toBeUndefined();
  dispose();
  expect(disposed).toBe(true);
});

test("a preview permit rejects an invalid host-selected port before registration", async () => {
  const binding = { projectId: "project", workspaceId: "fixture", connectionId: "connection",
    providerId: "incus", generation: 1, presetId: "incus-compose-v1",
    releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
    effectiveSettingsDigest: "c".repeat(64) };
  const target = sandboxWorkspaceTarget(binding, { previews: {
    open: async () => {}, serve: async () => new Response("ok"), close: async () => {},
  } } as SandboxWorkspaceBackend);
  let registered = false;
  await expect(registerClaimedQualificationPreview({
    key: { previewId: "preview", userId: "owner", conversationId: "conversation", binding, targetPort: 80 },
    runId: "run", nonce: "nonce", fixtureOperationId: "fixture", connectionRevision: 1,
    releaseDigest: binding.releaseDigest, expiresAtMs: 2000, target,
  }, { now: () => 1000, readCurrent: async () => null,
    register: () => { registered = true; return () => {}; } })).rejects.toThrow("permit is unavailable");
  expect(registered).toBe(false);
});
