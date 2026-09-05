import { afterEach, expect, mock, test } from "bun:test";
import { registerCallProvenance, releaseCallProvenance, resolveCallProvenance } from "../call-provenance";
import type { ExtensionDelivery } from "../v4/deliveries";

let active = true;
let userActive = true;
let conversationOwner = "caller";
let outcomeError = false;
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
    try { await handler(job); job.state = "delivered"; } catch { job.state = "outcome_unknown"; }
    return job;
  },
  async inspect(_installationId: string, id: string) { return jobs.find((job) => job.id === id) ?? null; },
};
mock.module("../extension-lifecycle-service", () => ({ getExtensionDeliveryQueue: async () => queue, getExtensionInstallationState: async () => ({ installation: { id: "installation", ownerId: "owner", scope: "global", generation: 3, activeReleaseId: "release", enabled: active } }) }));
mock.module("../../db/queries/users", () => ({ getUserById: async (id: string) => ({ id, status: userActive ? "active" : "inactive" }) }));
mock.module("../../db/queries/conversations", () => ({ getConversation: async () => ({ userId: conversationOwner }) }));
mock.module("../registry", () => ({ ExtensionRegistry: { getInstance: () => ({ getProcess: async () => process }) } }));
const { enqueueExtensionNotification, startExtensionDeliveryRuntime, stopExtensionDeliveryRuntime, drainExtensionDeliveries } = await import("../delivery-runtime");

function token(ownerless = false) { return registerCallProvenance({ actorExtensionId: "installation", onBehalfOf: ownerless ? null : "caller", conversationId: ownerless ? null : "conversation", runId: null, parentCallId: null, kind: "event", ownerless }); }
afterEach(async () => { await stopExtensionDeliveryRuntime(); jobs.length = 0; invocations.length = 0; active = true; userActive = true; conversationOwner = "caller"; outcomeError = false; });

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
    conversationOwner = revokeUser ? "caller" : "different";
    const ezCallId = token();
    try { await expect(enqueueExtensionNotification("installation", "ezcorp/event/test", { _meta: { ezCallId } })).rejects.toHaveProperty("code", "delivery_outcome_unknown"); } finally { releaseCallProvenance(ezCallId); }
  }
  expect(invocations).toHaveLength(0);
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
