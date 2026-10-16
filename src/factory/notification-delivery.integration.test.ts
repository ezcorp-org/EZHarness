/**
 * Delivery proof (C11 N1-N9, W4H-34): a real approval request and a real uncertain
 * release leave this host for a receiver running in a Podman container, and the
 * inbox actions an operator takes through the public application seam keep
 * authority and uncertainty.
 *
 * Bound to the `Factory deployment and operations` lane (scripts/check-factory-lanes.ts):
 * it needs Podman, the Bun image the product Dockerfile pins, and a real PostgreSQL.
 * Nothing here reaches a real person or a real external endpoint: the receiver
 * listens on host loopback and holds a certificate from a test authority.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { setupFactoryPostgres } from "../../tests/postgres/helpers/factory-test-database";
import { createFactoryReleaseWorld, FactoryGatedProvider, FactoryMemoryReleaseArchive, type FactoryReleaseWorld } from "../__tests__/helpers/factory-release-world";
import { issueTestWebhookReceiverTls, type ReceivedNotification } from "../__tests__/helpers/factory-webhook-receiver";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryPrincipal } from "./grants";
import { FactoryNotificationDelivery } from "./notification-delivery";
import { FactoryNotificationSender } from "./notification-sender";
import { FactoryReleaseApplication } from "./release-application";

const ROOT = join(import.meta.dir, "..", "..");
const TENANT = "delivery-tenant";
const PROJECT = "delivery-project";
const RUN = "delivery-run-7f3a";
const admin: FactoryPrincipal = { kind: "user", id: "delivery-admin", authentication: "session" };
const reviewer: FactoryPrincipal = { kind: "user", id: "delivery-reviewer", authentication: "session" };
const SECRET = randomBytes(32);
const never = new AbortController().signal;

/** The Bun image the product's own Dockerfile pins, so the proof adds no image. */
async function bunImage(): Promise<string> {
  const from = /^FROM (docker\.io\/oven\/bun:[0-9.]+@sha256:[a-f0-9]{64})/m.exec(await readFile(join(ROOT, "Dockerfile"), "utf8"));
  if (!from) throw new Error("the Dockerfile pins no Bun image by digest");
  return from[1]!;
}

async function podman(args: readonly string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, out: out + err };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

type Fixture = Awaited<ReturnType<typeof setupFactoryPostgres>>;
let fixture: Fixture;
let world: FactoryReleaseWorld;
let application: FactoryReleaseApplication;
let provider: FactoryGatedProvider;
let directory: string;
let inspect: string;
let receiverUrl: string;
let receiverCa: string;
const container = `w4h-34-receiver-${randomBytes(4).toString("hex")}`;

async function received(): Promise<{ requests: ReceivedNotification[]; logical: string[] }> {
  return await (await fetch(inspect)).json() as { requests: ReceivedNotification[]; logical: string[] };
}

beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  world = await createFactoryReleaseWorld({ database: fixture.db as never, tenantId: TENANT, projectId: PROJECT, admin, archive: new FactoryMemoryReleaseArchive(), now: Date.now });
  provider = new FactoryGatedProvider();
  application = new FactoryReleaseApplication(TENANT, world.grants, world.assurance, world.releases, { resolve: () => provider });
  await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${reviewer.id},'delivery-reviewer@example.test','x','reviewer','member')`);
  await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('delivery-reviewer-member',${PROJECT},${reviewer.id},'member')`);
  // The reviewer may read releases and operate them, but holds no approval authority.
  for (const action of ["factory.release", "factory.operate"] as const) await world.grants.set(admin, { projectId: PROJECT, principal: reviewer, action, expectedRevision: 0, expiresAtMs: null });

  directory = await mkdtemp(join(tmpdir(), "w4h-34-receiver-"));
  await chmod(directory, 0o755);
  const tls = await issueTestWebhookReceiverTls();
  for (const [name, text] of [["cert.pem", tls.cert], ["key.pem", tls.key], ["ca.pem", tls.ca]] as const) await writeFile(join(directory, name), text, { mode: 0o644 });
  receiverCa = tls.ca;
  const port = await freePort();
  const inspectPort = await freePort();
  receiverUrl = `https://127.0.0.1:${port}/factory/notifications`;
  inspect = `http://127.0.0.1:${inspectPort}/`;
  const started = await podman(["run", "-d", "--rm", "--name", container, "--network=host", "--pull=never",
    "-v", `${ROOT}:/app:ro`, "-v", `${directory}:/tls:ro`, "-w", "/app",
    "-e", `RECEIVER_PORT=${port}`, "-e", `RECEIVER_INSPECT_PORT=${inspectPort}`, "-e", `RECEIVER_SECRET=${SECRET.toString("hex")}`, "-e", "RECEIVER_TLS_DIR=/tls",
    await bunImage(), "bun", "src/__tests__/helpers/factory-webhook-receiver-main.ts"]);
  if (started.code !== 0) throw new Error(`the receiver container did not start: ${started.out}`);
  for (let tries = 0; tries < 60; tries += 1) {
    try { if ((await fetch(inspect)).ok) return; } catch { /* starting */ }
    await Bun.sleep(500);
  }
  throw new Error(`the receiver container never answered: ${(await podman(["logs", container])).out}`);
}, 120_000);

afterAll(async () => {
  // No stop grace: the receiver holds nothing to drain, and the proof's own process must not wait on it.
  await podman(["rm", "-f", "-t", "0", container]);
  await fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 60_000);

describe("an approval request and an uncertain release reach a receiver in a container (C11 N1-N9)", () => {
  let approvalOperation: string;
  let approval: { approvalId: string; contextDigest: string };
  let uncertainOperation: string;

  test("each is delivered once, signed, with no run, tenant or secret in it, and a re-drive adds nothing", async () => {
    const run = await world.acceptRun(RUN);
    const prepared = await run.prepareOnly("approval");
    approvalOperation = prepared.operationId;
    approval = await application.requestApproval(admin, PROJECT, approvalOperation, { expiresAtMs: Date.now() + 3_600_000 }, prepared.dispatchGeneration, "delivery-approval-request");
    const claim = await run.claimOnly("uncertain");
    uncertainOperation = claim.operationId;
    const dispatching = world.releases.dispatch(claim, provider);
    await provider.started;
    provider.answer("lost");
    expect(await dispatching).toMatchObject({ operationId: uncertainOperation, state: "uncertain" });

    // The in-app inbox delivers first, as the inbox role does; the sender carries only delivered notifications.
    const inbox = new FactoryNotificationDelivery(world.releases);
    while (await inbox.deliverNext(PROJECT)) { /* drain */ }
    const sender = new FactoryNotificationSender({ database: fixture.db as never, tenantId: TENANT, destinations: [{ name: "operators", url: receiverUrl, ca: receiverCa, secret: SECRET }] });
    expect(sender.confirmed()).toBe(false);
    while (await sender.step(never)) { /* drain */ }
    expect(sender.confirmed()).toBe(true);

    const seen = await received();
    expect(seen.requests).toHaveLength(2);
    expect(seen.logical).toHaveLength(2);
    expect(seen.requests.every((request) => request.signatureValid === true)).toBe(true);
    const bodies = seen.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ schema: "factory.notification.v1", kind: "approval_requested", operationId: approvalOperation, approvalId: approval.approvalId, projectId: PROJECT }),
      expect.objectContaining({ schema: "factory.notification.v1", kind: "release_uncertain", operationId: uncertainOperation, outcomeCode: "provider_response_unknown", projectId: PROJECT }),
    ]));
    for (const request of seen.requests) for (const forbidden of [RUN, TENANT, SECRET.toString("hex"), approval.contextDigest]) expect(request.body).not.toContain(forbidden);
    expect(rows<{ state: string }>(await fixture.db.execute(sql`SELECT state FROM factory_notification_sends ORDER BY state`)).map((row) => row.state)).toEqual(["delivered", "delivered"]);

    // A normal re-drive, by this sender or by one built after a restart, sends nothing again.
    expect(await sender.step(never)).toBe(false);
    const restarted = new FactoryNotificationSender({ database: fixture.db as never, tenantId: TENANT, destinations: [{ name: "operators", url: receiverUrl, ca: receiverCa, secret: SECRET }] });
    expect(await restarted.step(never)).toBe(false);
    expect(restarted.confirmed()).toBe(true);
    expect((await received()).requests).toHaveLength(2);
  }, 120_000);

  test("inbox actions through the public seam keep authority and uncertainty", async () => {
    const kinds = async (actor: FactoryPrincipal) => (await application.listNotifications(actor, PROJECT, { limit: 50 })).items.map((item) => item.kind).sort();
    // Authority: the approver sees both items; a member without factory.approve sees only the uncertain release.
    expect(await kinds(admin)).toEqual(["approval_requested", "release_uncertain"]);
    expect(await kinds(reviewer)).toEqual(["release_uncertain"]);
    // That member cannot answer the approval either, and it stays open.
    await expect(application.decideApproval(reviewer, PROJECT, approval.approvalId, { decision: "approved", contextDigest: approval.contextDigest }, 0, "reviewer-decides")).rejects.toThrow();
    expect(await kinds(admin)).toEqual(["approval_requested", "release_uncertain"]);
    // The approver answers it; the request leaves the inbox.
    await application.decideApproval(admin, PROJECT, approval.approvalId, { decision: "approved", contextDigest: approval.contextDigest }, 0, "admin-decides");
    expect(await kinds(admin)).toEqual(["release_uncertain"]);

    // Uncertainty: keeping it uncertain is a recorded human action and changes nothing else; nothing retries it.
    const kept = await application.reconcile(reviewer, PROJECT, uncertainOperation, { action: "keep_uncertain", reason: "provider status unknown; asked the destination owner", providerEvidence: { operationId: uncertainOperation } }, 1, "reviewer-keeps-uncertain");
    expect(kept).toMatchObject({ operationId: uncertainOperation, state: "uncertain" });
    expect(provider.calls).toBe(1);
    expect(await kinds(reviewer)).toEqual(["release_uncertain"]);
    // A verified provider receipt settles it, and the uncertain item leaves the inbox.
    const receipt = provider.receipts.get(uncertainOperation)!;
    const settled = await application.reconcile(reviewer, PROJECT, uncertainOperation, { action: "attach_receipt", reason: "the destination confirmed the write", providerEvidence: { operationId: uncertainOperation }, receipt }, 1, "reviewer-attaches-receipt");
    expect(settled).toMatchObject({ operationId: uncertainOperation, state: "succeeded" });
    expect(await kinds(reviewer)).not.toContain("release_uncertain");
    expect(provider.calls).toBe(1);

    // None of these actions sent anything new off this host: a settlement is not an outbound kind.
    const inbox = new FactoryNotificationDelivery(world.releases);
    while (await inbox.deliverNext(PROJECT)) { /* drain */ }
    const sender = new FactoryNotificationSender({ database: fixture.db as never, tenantId: TENANT, destinations: [{ name: "operators", url: receiverUrl, ca: receiverCa, secret: SECRET }] });
    while (await sender.step(never)) { /* drain */ }
    expect((await received()).requests).toHaveLength(2);
    if (process.env.W4H34_EVIDENCE_DIR) await writeFile(join(process.env.W4H34_EVIDENCE_DIR, "delivery-received.json"), JSON.stringify(await received(), null, 2));
  }, 120_000);
});
