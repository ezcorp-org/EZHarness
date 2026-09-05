import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../../src/__tests__/helpers/test-pglite";
import { buildIsolatedRelease } from "../../../src/__tests__/helpers/first-party-release";
import { getExtensionDeliveryQueue, getExtensionLifecycle } from "../../../src/extensions/extension-lifecycle-service";
import { configureReleaseRuntime } from "../../../src/extensions/release-process";
import { enqueueExtensionNotification, startExtensionDeliveryRuntime, stopExtensionDeliveryRuntime } from "../../../src/extensions/delivery-runtime";
import { createPermissionEngine, _setPermissionEngineForTests } from "../../../src/extensions/permission-engine";
import { ToolExecutor } from "../../../src/extensions/tool-executor";
import { EventBus } from "../../../src/runtime/events";
import { registerExtensionEvent } from "../../../src/runtime/sse-conversation-filter";
import { getUserById } from "../../../src/db/queries/users";
import { getEventReceipt } from "../../../src/db/queries/extension-event-receipts";
import { makeRequestEvent } from "./helpers/server-route-test-utils";
import type { AgentEvents } from "../../../src/types";
import { extensions } from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import { setExtensionProjectBinding } from "../../../src/extensions/project-binding";

mockDbConnection();
const bus = new EventBus<AgentEvents>();
mock.module("$lib/server/context", () => ({ getBus: () => bus, getExecutor: () => ({ spawnQuota: {} }) }));
const { POST, __hubActionRateLimiter } = await import("../routes/api/extensions/[name]/events/[event]/+server");
beforeEach(() => __hubActionRateLimiter.reset());
let release: Awaited<ReturnType<typeof buildIsolatedRelease>>;
let session: Awaited<ReturnType<typeof release.session>>;
let wire: Parameters<typeof startExtensionDeliveryRuntime>[0];
const manifest = { schemaVersion: 4, name: "hub-proof", version: "1.0.0", description: "Isolated Hub proof", author: { name: "Test" }, pages: [{ id: "control", title: "Control" }], permissions: { storage: true, eventSubscriptions: ["hub-proof:save", "hub-proof:reject"] } };

beforeAll(async () => {
  await setupTestDb();
  await getExtensionLifecycle();
  release = await buildIsolatedRelease({
    "manifest.ts": `export default ${JSON.stringify(manifest)};`,
    "manifest.test.ts": 'import {expect,test} from "bun:test"; import manifest from "./manifest"; test("declared control actions",()=>{expect(manifest.pages[0].id).toBe("control");expect(manifest.permissions.eventSubscriptions).toHaveLength(2);});',
    "extension.ts": 'import {createRuntimeExtension,serve} from "@ezcorp/sdk/v4"; import {definePage,PageBuilder,Storage,getChannel} from "@ezcorp/sdk/runtime"; import manifest from "./manifest"; const extension=await createRuntimeExtension({manifest,register:()=>{const store=new Storage("global");definePage({id:"control",render:()=>new PageBuilder().heading(1,"Control").build(),actions:{"hub-proof:save":async event=>{await store.set("saved",event.payload??null);},"hub-proof:reject":async()=>{throw new Error("controlled worker rejection");}}});getChannel().start();}});await serve(extension);',
  }, "extension.ts");
  session = await release.session({ persistRelease: true });
  const engine = createPermissionEngine({ registry: session.registry, bus, db: getTestDb() });
  _setPermissionEngineForTests(engine);
  const executor = new ToolExecutor(session.registry, engine, { bus, eventDriven: true });
  configureReleaseRuntime({ ...session.runtime, dispatchNotification: (id, method, params) => enqueueExtensionNotification(id, method, params ?? {}) });
  wire = (id, process) => executor.ensureSubprocessRpcWired(id, process);
  startExtensionDeliveryRuntime(wire);
  registerExtensionEvent("hub-proof", "save");
  registerExtensionEvent("hub-proof", "reject");
}, 120_000);

afterAll(async () => {
  await stopExtensionDeliveryRuntime();
  await session?.close();
  await release?.close();
  await closeTestDb();
});

async function post(event: string, key: string, payload: Record<string, unknown> = {}, pageId = "control") {
  return POST(makeRequestEvent(`http://localhost/api/extensions/hub-proof/events/${event}`, {
    params: { name: "hub-proof", event },
    request: { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ source: "hub", pageId, payload }) },
    locals: { user: await getUserById(session.userId) },
  }));
}

test("conversationless Hub action reaches one isolated worker and receipt retries never repeat it", async () => {
  expect(session.starts()).toBe(0);
  expect((await post("save", "action-one", { value: "first", projectRoot: "/unapproved/private" })).status).toBe(200);
  expect(await session.storage("saved")).toEqual({ value: "first", projectRoot: "/unapproved/private" });
  expect(session.starts()).toBe(1);
  expect((await post("save", "action-one", { value: "first", projectRoot: "/unapproved/private" })).status).toBe(200);
  expect(session.starts()).toBe(1);
  expect((await post("save", "action-one", { value: "different" })).status).toBe(409);
  expect(session.starts()).toBe(1);
  const receipt = await getEventReceipt(getTestDb(), { principalId: session.userId, namespace: "hub-proof:save", key: "action-one" });
  expect(receipt?.scope).toBe(session.id);
  expect(receipt?.deliveryIds).toHaveLength(1);
  const delivery = await (await getExtensionDeliveryQueue()).inspect(session.id, receipt!.deliveryIds[0]!);
  expect(delivery?.input).toMatchObject({ origin: "hub", provenance: { onBehalfOf: session.userId, conversationId: null } });
  expect((delivery!.input as { provenance: object }).provenance).not.toHaveProperty("projectId");
  expect((delivery!.input as { provenance: object }).provenance).not.toHaveProperty("projectBindingId");
}, 60_000);

test("unrecognized actions and pages fail before admission, and queued grant revocation precedes worker start", async () => {
  const starts = session.starts();
  expect((await post("unknown", "unknown-action")).status).toBe(404);
  expect((await post("save", "unknown-page", {}, "unknown")).status).toBe(404);
  expect((await post("save", "")).status).toBe(400);
  const original = await session.installed();
  await stopExtensionDeliveryRuntime();
  const response = post("save", "revoked-queued", { value: "must-not-run" });
  const identity = { principalId: session.userId, namespace: "hub-proof:save", key: "revoked-queued" };
  try {
    for (let attempt = 0; attempt < 100 && !(await getEventReceipt(getTestDb(), identity)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await getEventReceipt(getTestDb(), identity)).not.toBeNull();
    await getTestDb().update(extensions).set({ grantedPermissions: { grantedAt: {}, storage: true } }).where(eq(extensions.id, session.id));
    startExtensionDeliveryRuntime(wire);
    expect((await response).status).toBe(500);
    expect(session.starts()).toBe(starts);
  } finally {
    startExtensionDeliveryRuntime(wire);
    await response;
    await getTestDb().update(extensions).set({ grantedPermissions: original!.grantedPermissions }).where(eq(extensions.id, session.id));
  }
}, 60_000);

test("rejected isolated worker action is not acknowledged as HTTP success or retried", async () => {
  const starts = session.starts();
  expect((await post("reject", "rejected-action")).status).toBe(500);
  expect(session.starts()).toBe(starts + 1);
  expect((await post("reject", "rejected-action")).status).toBe(500);
  expect(session.starts()).toBe(starts + 1);
}, 60_000);

test("only a current human-approved project binding supplies Hub scope and revocation stops queued work", async () => {
  const actor = { kind: "human" as const, principalId: session.userId, scope: "global" };
  const input = { installationId: session.id, releaseId: session.snapshot.release.id, generation: session.snapshot.installation.generation };
  const binding = await setExtensionProjectBinding(actor, { ...input, projectId: session.projectId });
  expect((await post("save", "bound-action", { projectRoot: "/wrong-project" })).status).toBe(200);
  const identity = { principalId: session.userId, namespace: "hub-proof:save", key: "bound-action" };
  const receipt = await getEventReceipt(getTestDb(), identity);
  const delivery = await (await getExtensionDeliveryQueue()).inspect(session.id, receipt!.deliveryIds[0]!);
  expect(delivery?.input).toMatchObject({ provenance: { projectId: session.projectId, projectBindingId: binding!.id } });
  const starts = session.starts();
  await stopExtensionDeliveryRuntime();
  const response = post("save", "binding-revoked", {});
  try {
    for (let attempt = 0; attempt < 100 && !(await getEventReceipt(getTestDb(), { ...identity, key: "binding-revoked" })); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await getEventReceipt(getTestDb(), { ...identity, key: "binding-revoked" })).not.toBeNull();
    await setExtensionProjectBinding(actor, { ...input, projectId: null });
    startExtensionDeliveryRuntime(wire);
    expect((await response).status).toBe(500);
    expect(session.starts()).toBe(starts);
  } finally { startExtensionDeliveryRuntime(wire); await response; }
}, 60_000);
