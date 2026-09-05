import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type { ExtensionProjectBinding } from "../project-binding";
import { registerCallProvenance, releaseCallProvenance, resolveCallProvenance } from "../call-provenance";
import type { ExtensionDelivery } from "../v4/deliveries";

let active = true;
let userActive = true;
let conversationOwner = "caller";
let outcomeError = false;
let conversationProject: string | null = null;
let projectMember = true;
let binding: ExtensionProjectBinding | null = null;
let beforeDispatch = () => {};
let eventWired = true;
let eventGranted = true;
let paused = false;
const jobs: ExtensionDelivery[] = [];
const invocations: { method: string; params: Record<string, unknown> }[] = [];
const process = { async call(method: string, params: Record<string, unknown>) { invocations.push({ method, params }); if (outcomeError) throw new Error("unknown effect"); return { jsonrpc: "2.0", id: "response", result: null }; } };
const queue = {
  async enqueue(input: Omit<ExtensionDelivery, "id" | "state" | "attempts" | "maxAttempts" | "availableAt" | "leaseUntil" | "createdAt">) {
    const existing = jobs.find((job) => job.deduplicationId === input.deduplicationId);
    if (existing) return existing;
    const job: ExtensionDelivery = { ...input, id: crypto.randomUUID(), state: "queued", attempts: 0, maxAttempts: 3, availableAt: 0, leaseUntil: 0, createdAt: 0 };
    jobs.push(job);
    return job;
  },
  async dispatch(handler: (job: ExtensionDelivery) => Promise<void>) {
    const job = jobs.find((candidate) => candidate.state === "queued");
    if (!job) return null;
    job.state = "leased";
    beforeDispatch();
    try { await handler(job); job.state = "delivered"; } catch { job.state = "outcome_unknown"; }
    return job;
  },
  async inspect(_installationId: string, id: string) { return jobs.find((job) => job.id === id) ?? null; },
};
mock.module("../extension-lifecycle-service", () => ({ getExtensionDeliveryQueue: async () => queue, getExtensionInstallationState: async () => ({ installation: { id: "installation", ownerId: "owner", scope: "global", generation: 3, activeReleaseId: "release", enabled: active } }) }));
mock.module("../../db/queries/users", () => ({ getUserById: async (id: string) => ({ id, status: userActive ? "active" : "inactive" }) }));
mock.module("../../db/queries/conversations", () => ({ getConversation: async () => ({ userId: conversationOwner, projectId: conversationProject }) }));
mock.module("../../db/queries/conversation-extensions", () => ({ getConversationExtensionIds: async () => eventWired ? ["installation"] : [] }));
mock.module("../../db/queries/extensions", () => ({ getExtension: async () => ({ enabled: active, grantedPermissions: { eventSubscriptions: eventGranted ? ["test"] : [] } }) }));
mock.module("../loops-kill-switch", () => ({ loopsKillSwitchEngaged: async () => paused }));
mock.module("../project-binding", () => ({ getExtensionProjectBinding: async () => binding }));
mock.module("../../auth/middleware", () => ({ checkProjectRole: async () => projectMember ? undefined : new Response(null, { status: 403 }) }));
mock.module("../registry", () => ({ ExtensionRegistry: { getInstance: () => ({ getProcess: async () => process }) } }));
const { enqueueExtensionNotification, startExtensionDeliveryRuntime, stopExtensionDeliveryRuntime, drainExtensionDeliveries } = await import("../delivery-runtime");

function token(ownerless = false) { return registerCallProvenance({ actorExtensionId: "installation", onBehalfOf: ownerless ? null : "caller", conversationId: ownerless ? null : "conversation", runId: null, parentCallId: null, kind: "event", ownerless }); }
afterEach(async () => { await stopExtensionDeliveryRuntime(); jobs.length = 0; invocations.length = 0; active = true; userActive = true; conversationOwner = "caller"; outcomeError = false; conversationProject = null; projectMember = true; binding = null; beforeDispatch = () => {}; eventWired = true; eventGranted = true; paused = false; });
afterAll(() => restoreModuleMocks());

test("the emergency pause retains queued delivery without consuming a worker attempt", async () => {
  startExtensionDeliveryRuntime(() => {});
  paused = true;
  const ezCallId = token();
  try {
    const pending = enqueueExtensionNotification("installation", "ezcorp/event/test", { _meta: { ezCallId } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(jobs[0]?.state).toBe("queued");
    expect(invocations).toHaveLength(0);
    paused = false;
    await pending;
    expect(invocations).toHaveLength(1);
  } finally { releaseCallProvenance(ezCallId); }
});

test("event wiring and live event grant are checked again before worker dispatch", async () => {
  startExtensionDeliveryRuntime(() => {});
  for (const revoke of ["wiring", "grant"] as const) {
    eventWired = true; eventGranted = true;
    beforeDispatch = () => { if (revoke === "wiring") eventWired = false; else eventGranted = false; };
    const ezCallId = token();
    try { await expect(enqueueExtensionNotification("installation", "ezcorp/event/test", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_outcome_unknown"); } finally { releaseCallProvenance(ezCallId); }
  }
  expect(invocations).toHaveLength(0);
});

test("queues frozen release identity and acknowledges handler completion", async () => {
  const wire = mock(() => {});
  startExtensionDeliveryRuntime(wire);
  const ezCallId = token();
  try { await enqueueExtensionNotification("installation", "ezcorp/event/test", { deliveryId: "source", value: "data", _meta: { ezCallId } }); } finally { releaseCallProvenance(ezCallId); }
  expect(jobs[0]).toMatchObject({ releaseId: "release", generation: 3, principalId: "owner", state: "delivered" });
  expect(jobs[0]!.input).toMatchObject({ provenance: { onBehalfOf: "caller" }, params: { value: "data" } });
  expect(wire).toHaveBeenCalledTimes(1);
  const metadata = invocations[0]!.params._meta as Record<string, unknown>;
  expect(metadata).toMatchObject({ releaseId: "release", expectedGeneration: 3 });
  expect(resolveCallProvenance(metadata.ezCallId as string)).toBeUndefined();
});

test("background delivery freezes the installation owner instead of using a singleton", async () => {
  startExtensionDeliveryRuntime(() => {});
  const ezCallId = token(true);
  try { await enqueueExtensionNotification("installation", "ezcorp/webhook-fire", { deliveryId: "webhook", _meta: { ezCallId } }); } finally { releaseCallProvenance(ezCallId); }
  expect(jobs[0]!.input).toMatchObject({ provenance: { onBehalfOf: "owner", ownerless: false } });
  expect(jobs[0]!.kind).toBe("webhook");
});

test("revoked users and changed conversation ownership cannot receive effects", async () => {
  startExtensionDeliveryRuntime(() => {});
  for (const revokeUser of [true, false]) {
    userActive = !revokeUser;
    beforeDispatch = () => { conversationOwner = revokeUser ? "caller" : "different"; };
    const ezCallId = token();
    try { await expect(enqueueExtensionNotification("installation", "ezcorp/event/test", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_outcome_unknown"); } finally { releaseCallProvenance(ezCallId); }
  }
  expect(invocations).toHaveLength(0);
});

test("project authority comes from host records, not event parameters or caller hints", async () => {
  startExtensionDeliveryRuntime(() => {});
  binding = { id: "approval", projectId: "project", ownerId: "owner", releaseId: "release", generation: 3, approvedAt: "2026-09-04T00:00:00.000Z", writePaths: ["docs/"] };
  const ezCallId = token(true);
  try { await enqueueExtensionNotification("installation", "ezcorp/schedule-fire", { projectId: "attacker", repo_path: "/private", _meta: { ezCallId } }); } finally { releaseCallProvenance(ezCallId); }
  expect(jobs[0]!.input).toMatchObject({ provenance: { projectId: "project", projectBindingId: "approval", onBehalfOf: "owner" } });
  conversationProject = "conversation-project";
  const conversationToken = registerCallProvenance({ actorExtensionId: "installation", onBehalfOf: "caller", conversationId: "conversation", projectId: "attacker", projectBindingId: "forged", runId: null, parentCallId: null, kind: "event", ownerless: false });
  try { await enqueueExtensionNotification("installation", "event", { _meta: { ezCallId: conversationToken } }); } finally { releaseCallProvenance(conversationToken); }
  expect(jobs[1]!.input).toMatchObject({ provenance: { projectId: "conversation-project" } });
  expect((jobs[1]!.input as { provenance: unknown }).provenance).not.toHaveProperty("projectBindingId");
});

test("queued work cannot retain a revoked or replaced project approval", async () => {
  startExtensionDeliveryRuntime(() => {});
  for (const mutation of ["revoke", "rebind", "membership", "project"] as const) {
    binding = { id: "approval", projectId: "project", ownerId: "owner", releaseId: "release", generation: 3, approvedAt: "same-time", writePaths: ["docs/"] };
    projectMember = true;
    beforeDispatch = () => {
      if (mutation === "revoke") binding = null;
      else if (mutation === "rebind") binding = { ...binding!, id: "new-approval" };
      else if (mutation === "membership") projectMember = false;
      else binding = { ...binding!, projectId: "other-project" };
    };
    const ezCallId = token(true);
    try { await expect(enqueueExtensionNotification("installation", "event", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_outcome_unknown"); } finally { releaseCallProvenance(ezCallId); }
  }
  expect(invocations).toHaveLength(0);
});

test("wrong project owners and missing membership fail before enqueue", async () => {
  binding = { id: "approval", projectId: "project", ownerId: "other", releaseId: "release", generation: 3, approvedAt: "time", writePaths: ["docs/"] };
  const ezCallId = token(true);
  try {
    await expect(enqueueExtensionNotification("installation", "event", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_revoked");
    binding = { ...binding, ownerId: "owner" };
    projectMember = false;
    await expect(enqueueExtensionNotification("installation", "event", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_revoked");
  } finally { releaseCallProvenance(ezCallId); }
  expect(jobs).toHaveLength(0);
});

test("unknown external outcomes are not executed again on duplicate delivery", async () => {
  startExtensionDeliveryRuntime(() => {});
  outcomeError = true;
  const ezCallId = token();
  try {
    for (let attempt = 0; attempt < 2; attempt++) await expect(enqueueExtensionNotification("installation", "ezcorp/schedule-fire", { deliveryId: "schedule", _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_outcome_unknown");
  } finally { releaseCallProvenance(ezCallId); }
  expect(invocations).toHaveLength(1);
});

test("missing, foreign and retired delivery identities fail closed", async () => {
  await drainExtensionDeliveries();
  await expect(enqueueExtensionNotification("installation", "event", {})).rejects.toHaveProperty("code", "invalid_delivery");
  const ezCallId = token();
  try {
    await expect(enqueueExtensionNotification("other", "event", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "invalid_delivery");
    active = false;
    await expect(enqueueExtensionNotification("installation", "event", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_revoked");
  } finally { releaseCallProvenance(ezCallId); }
});

test("a pending delivery timeout preserves queued work without inventing completion", async () => {
  const initialTime = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(initialTime);
  let inspections = 0;
  const inspect = queue.inspect;
  const inspection = spyOn(queue, "inspect").mockImplementation(async (installationId, id) => {
    if (++inspections === 3) clock.mockReturnValue(initialTime + 60_001);
    return inspect(installationId, id);
  });
  const ezCallId = token();
  try {
    await expect(enqueueExtensionNotification("installation", "event", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_pending");
    expect(jobs[0]?.state).toBe("queued");
    expect(invocations).toHaveLength(0);
  } finally { releaseCallProvenance(ezCallId); clock.mockRestore(); inspection.mockRestore(); }
});
