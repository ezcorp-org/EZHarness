import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import { up } from "../../db/migrations/add-factory-inbox";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { durableInputHash } from "../../delivery-queue/durable-delivery-queue";
import { FactoryInbox, type FactoryInboxKey, type FactoryInboxIdentity } from "../../factory/inbox";
import { FactoryCommandOutbox, FactoryInstallationCommandOutbox } from "../../factory/outbox";
import { FactoryTransportQueue } from "../../factory/transport-queue";
import { FactoryRecords, type FactoryAuditInput } from "../../factory/records";

export function factoryInboxConformance(create: () => Promise<{ db: TransactionalDb; close(): Promise<void> }>): void {
  let fixture: Awaited<ReturnType<typeof create>>;
  let inbox: FactoryInbox;
  let records: FactoryRecords;
  let count = 0;
  beforeAll(async () => {
    fixture = await create();
    inbox = new FactoryInbox(fixture.db, "inbox-tenant", () => 10);
    records = new FactoryRecords(fixture.db, "inbox-tenant");
    await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('inbox-project', 'Inbox', '/tmp/factory-inbox-project')`);
    await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name) VALUES ('inbox-human', 'inbox@example.test', 'not-a-login-hash', 'Inbox')`);
    await records.bindProject("inbox-project");
  });
  afterAll(async () => { await fixture?.close(); });
  async function run(): Promise<FactoryInboxKey> {
    const key = { projectId: "inbox-project", runId: `inbox-run-${++count}`, interpreterId: "root" };
    await fixture.db.transaction(tx => records.createRunInTransaction(tx, { ...key, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "kernel-v1", executionEpoch: 1, input: {}, principalId: "inbox-human" }, async (transaction, request) => {
      const outbox = new FactoryCommandOutbox(fixture.db, "inbox-tenant", key.projectId, () => 10);
      await outbox.enqueueInTransaction(transaction, { kind: "start_run", projectId: key.projectId, logicalRunId: key.runId, interpreterId: key.interpreterId, body: request });
    }));
    return key;
  }
  const event = (id: string): Extract<KernelEvent, { kind: "cancel" }> => ({ kind: "cancel", id, atMs: 10, reason: "operator requested cancellation" });
  const proof = (value: KernelEvent, sequence = 1): FactoryInboxIdentity => ({ inboxSequence: sequence, eventId: value.id, eventHash: durableInputHash(value) });
  const audit = (key: FactoryInboxKey, value: FactoryInboxIdentity, sourceSequence = 1, predecessorDigest: string | null = null): FactoryAuditInput => ({ ...key, sourceSequence, predecessorDigest, payload: { ...value, transitionId: `transition-${sourceSequence}`, artifactManifestRef: { objectId: "immutable-transition", digest: `sha256:${"b".repeat(64)}`, encodedBytes: 256 } } });

  describe("durable inbox and exact applied receipts", () => {
    test("migration and duplicate enqueue are idempotent under races and partition scoped", async () => {
      await up(fixture.db);
      const key = await run();
      const value = event("same-event");
      const deliveries = await Promise.all([inbox.enqueue(key, value), inbox.enqueue(key, value)]);
      expect(deliveries[0]).toEqual(deliveries[1]);
      expect(deliveries[0]!.command).toMatchObject({ interpreterId: "root", eventId: value.id, eventSequence: 1, eventHash: proof(value).eventHash, body: value });
      const other = await inbox.enqueue({ ...key, interpreterId: "partition-two" }, value);
      expect(other.id).not.toBe(deliveries[0]!.id);
      const notice = await inbox.enqueue(key, event("notice"), "partition_notification");
      expect(notice.command).toMatchObject({ kind: "partition_notification", eventSequence: 2 });
      await expect(inbox.enqueue(key, { ...value, reason: "different" })).rejects.toMatchObject({ code: "factory_inbox_conflict" });
      await expect(inbox.enqueue(key, value, "partition_notification")).rejects.toMatchObject({ code: "factory_inbox_conflict" });
      const starts = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_command_outbox WHERE logical_run_id=${key.runId} AND payload::jsonb->'command'->>'kind'='start_run'`));
      expect(JSON.parse(starts[0]!.payload).command.interpreterId).toBe("root");
    });

    test("only the exact committed applied event proves delivery after response loss", async () => {
      const key = await run();
      const a = event("event-a");
      const b = event("event-b");
      await inbox.enqueue(key, a); await inbox.enqueue(key, b);
      expect(await inbox.confirmApplied(key, proof(a))).toBe(false);
      await inbox.commitTransition(audit(key, proof(b, 2)));
      // A workflow high-water of 2 does not prove event A was ever applied.
      expect(await inbox.confirmApplied(key, proof(a))).toBe(false);
      expect(await inbox.confirmApplied(key, proof(b, 2))).toBe(true);
      expect(await inbox.confirmApplied(key, proof(b, 1))).toBe(false);
      expect(await inbox.confirmApplied(key, { ...proof(b, 2), eventHash: proof(a).eventHash })).toBe(false);
      expect(await inbox.confirmApplied({ ...key, interpreterId: "foreign" }, proof(b, 2))).toBe(false);
      expect(await inbox.confirmApplied({ ...key, projectId: "foreign" }, proof(b, 2))).toBe(false);
      expect(await new FactoryInbox(fixture.db, "foreign").confirmApplied(key, proof(b, 2))).toBe(false);
      const first = (await records.readAudit(key))[0]!;
      const second = audit(key, proof(a), 2, first.digest);
      await inbox.commitTransition(second);
      await inbox.commitTransition(second);
      expect(await inbox.confirmApplied(key, proof(a))).toBe(true);
      expect((await inbox.enqueue(key, a)).command.eventSequence).toBe(1);
      const secondBatch = (await records.readAudit(key))[1]!;
      await expect(inbox.commitTransition(audit(key, proof(a), 3, secondBatch.digest))).rejects.toMatchObject({ code: "factory_inbox_applied_conflict" });
      expect(await records.readAudit(key)).toHaveLength(2);
    });

    test("wrong applied identities and receipt-write failure roll back the audit", async () => {
      const key = await run();
      const value = event("atomic");
      await inbox.enqueue(key, value);
      for (const invalid of [proof(event("missing")), proof(value, 2), { ...proof(value), eventHash: proof(event("wrong")).eventHash }]) {
        await expect(inbox.commitTransition(audit(key, invalid))).rejects.toMatchObject({ code: "factory_inbox_applied_conflict" });
      }
      expect(await records.readAudit(key)).toEqual([]);
      await fixture.db.execute(sql`CREATE FUNCTION reject_factory_inbox_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt unavailable'; END $$`);
      await fixture.db.execute(sql`CREATE TRIGGER reject_factory_inbox_receipt BEFORE UPDATE ON factory_inbox_events FOR EACH ROW EXECUTE FUNCTION reject_factory_inbox_receipt()`);
      try { await expect(inbox.commitTransition(audit(key, proof(value)))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("receipt unavailable") }) }); }
      finally {
        await fixture.db.execute(sql`DROP TRIGGER reject_factory_inbox_receipt ON factory_inbox_events`);
        await fixture.db.execute(sql`DROP FUNCTION reject_factory_inbox_receipt()`);
      }
      expect(await records.readAudit(key)).toEqual([]);
      expect(await inbox.confirmApplied(key, proof(value))).toBe(false);
      await inbox.commitTransition(audit(key, proof(value)));
      expect(await inbox.confirmApplied(key, proof(value))).toBe(true);
      const next = (await records.readAudit(key))[0]!;
      await inbox.commitTransition({ ...key, sourceSequence: 2, predecessorDigest: next.digest, payload: { eventId: "internal", eventHash: proof(event("internal")).eventHash } });
      expect(await records.readAudit(key)).toHaveLength(2);
    });

    test("caller and outbox failure leave no inbox fact or sequence gap", async () => {
      const key = await run();
      await expect(fixture.db.transaction(async tx => {
        await inbox.enqueueInTransaction(tx, key, event("rolled-back"));
        throw new Error("caller failed");
      })).rejects.toThrow("caller failed");
      await fixture.db.execute(sql`CREATE FUNCTION reject_factory_inbox_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'command unavailable'; END $$`);
      await fixture.db.execute(sql`CREATE TRIGGER reject_factory_inbox_outbox BEFORE INSERT ON factory_command_outbox FOR EACH ROW EXECUTE FUNCTION reject_factory_inbox_outbox()`);
      try { await expect(inbox.enqueue(key, event("failed-command"))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("command unavailable") }) }); }
      finally {
        await fixture.db.execute(sql`DROP TRIGGER reject_factory_inbox_outbox ON factory_command_outbox`);
        await fixture.db.execute(sql`DROP FUNCTION reject_factory_inbox_outbox()`);
      }
      expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${key.runId}`))).toEqual([]);
      expect((await inbox.enqueue(key, event("accepted"))).command.eventSequence).toBe(1);
    });

    test("the unacknowledged sequence window stays bounded even with later applied events", async () => {
      const key = await run();
      for (let index = 1; index <= 128; index++) await inbox.enqueue(key, event(`bounded-${index}`));
      await expect(inbox.enqueue(key, event("overflow"))).rejects.toMatchObject({ code: "factory_inbox_full" });
      await inbox.commitTransition(audit(key, proof(event("bounded-128"), 128)));
      await expect(inbox.enqueue(key, event("still-overflow"))).rejects.toMatchObject({ code: "factory_inbox_full" });
      expect((await inbox.enqueue(key, event("bounded-1"))).command.eventSequence).toBe(1);
      const first = (await records.readAudit(key))[0]!;
      await inbox.commitTransition(audit(key, proof(event("bounded-1")), 2, first.digest));
      expect((await inbox.enqueue(key, event("now-accepted"))).command.eventSequence).toBe(129);
    });

    test("corrupt event bytes, receipt pointers and audited identities fail closed", async () => {
      const key = await run();
      const value = event("corrupt");
      await inbox.enqueue(key, value);
      await fixture.db.execute(sql`UPDATE factory_inbox_events SET payload=${JSON.stringify(event("tampered"))} WHERE run_id=${key.runId}`);
      await expect(inbox.enqueue(key, value)).rejects.toMatchObject({ code: "factory_inbox_corrupt" });
      await fixture.db.execute(sql`UPDATE factory_inbox_events SET payload=${JSON.stringify(value)} WHERE run_id=${key.runId}`);
      await inbox.commitTransition(audit(key, proof(value)));
      await fixture.db.execute(sql`UPDATE factory_inbox_events SET applied_digest='corrupt' WHERE run_id=${key.runId}`);
      await expect(inbox.confirmApplied(key, proof(value))).rejects.toMatchObject({ code: "factory_inbox_receipt_corrupt" });
      const batch = (await records.readAudit(key))[0]!;
      await fixture.db.execute(sql`UPDATE factory_inbox_events SET applied_digest=${batch.digest} WHERE run_id=${key.runId}`);
      await fixture.db.execute(sql`UPDATE factory_audit_batches SET payload='{}' WHERE run_id=${key.runId}`);
      await expect(inbox.confirmApplied(key, proof(value))).rejects.toMatchObject({ code: "factory_audit_corrupt" });
      expect(await fixture.db.transaction(tx => records.readAuditBatchInTransaction(tx, { ...key, interpreterId: "missing" }, 1))).toBeNull();
    });

    test("transport claims use stored bytes, lease fencing and exact applied reconciliation", async () => {
      const key = await run();
      await fixture.db.execute(sql`UPDATE factory_command_outbox SET state='delivered'`);
      const value = event("transport");
      await inbox.enqueue(key, value);
      let now = 10;
      const outbox = new FactoryCommandOutbox(fixture.db, "inbox-tenant", key.projectId, () => now);
      const queue = new FactoryTransportQueue(outbox, inbox);
      expect(() => new FactoryTransportQueue(outbox, new FactoryInbox(fixture.db, "foreign"))).toThrow("factory_command_scope_mismatch");
      const claim = (await queue.claim())!;
      expect(claim.command.eventId).toBe(value.id);
      expect(await queue.claim()).toBeNull();
      expect(await queue.confirmInboxIdentity(claim.command)).toBe(false);
      await expect(queue.settle({ ...claim, command: { ...claim.command, body: {} } }, "delivered")).rejects.toMatchObject({ code: "factory_command_conflict" });
      await expect(queue.settle({ ...claim, command: { ...claim.command, tenantId: "foreign" } }, "delivered")).rejects.toMatchObject({ code: "factory_command_scope_mismatch" });
      await expect(queue.settle({ ...claim, claimToken: "foreign" }, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
      expect(await queue.confirmInboxIdentity({ ...claim.command, body: {} })).toBe(false);
      expect(await queue.confirmInboxIdentity({ ...claim.command, kind: "start_run" })).toBe(false);
      await expect(queue.confirmInboxIdentity({ ...claim.command, interpreterId: undefined })).rejects.toThrow();
      await inbox.commitTransition(audit(key, proof(value)));
      expect(await queue.confirmInboxIdentity(claim.command)).toBe(true);
      await queue.settle(claim, "retry", "not_sent");
      now += 1001;
      const replacement = (await queue.claim())!;
      expect(replacement.claimToken).not.toBe(claim.claimToken);
      await expect(queue.settle(claim, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
      await queue.settle(replacement, "delivered");
      expect((await outbox.inspect(claim.command.commandId))?.state).toBe("delivered");
      expect(await queue.claim()).toBeNull();
      const malformed = await outbox.enqueue({ kind: "decision", projectId: key.projectId, logicalRunId: key.runId, interpreterId: "root", decisionId: "legacy-incomplete", body: {} });
      await expect(queue.claim()).rejects.toMatchObject({ code: "factory_command_transport_invalid" });
      await fixture.db.execute(sql`UPDATE factory_command_outbox SET payload=jsonb_set(payload::jsonb, '{command,body}', '{"changed":true}'::jsonb)::text WHERE id=${malformed.id}`);
      await expect(outbox.inspect(malformed.id)).rejects.toMatchObject({ code: "factory_command_corrupt" });
    });

    test("one installation dispatcher claims across projects while preserving destination, tenant and lease fences", async () => {
      await fixture.db.execute(sql`UPDATE factory_command_outbox SET state='delivered'`);
      const keys = [] as FactoryInboxKey[];
      for (const projectId of ["installation-one", "installation-two"]) {
        await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},${projectId},${`/tmp/${projectId}`})`);
        await records.bindProject(projectId);
        const key = { projectId, runId: `${projectId}-run`, interpreterId: "root" };
        await records.createRun({ ...key, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "v1", executionEpoch: 1, input: {}, principalId: "inbox-human" }, async () => {});
        keys.push(key);
        await inbox.enqueue(key, event(projectId));
        await new FactoryCommandOutbox(fixture.db, inbox.tenantId, projectId, () => 10, "pool").enqueue({ kind: "compute_admission", projectId, logicalRunId: key.runId, reservationId: projectId, body: {} });
      }
      let now = 10;
      const outbox = new FactoryInstallationCommandOutbox(fixture.db, inbox.tenantId, () => now);
      const queue = new FactoryTransportQueue(outbox, inbox);
      const claims = await Promise.all([queue.claim(), queue.claim()]);
      expect(new Set(claims.map(claim => claim!.command.projectId))).toEqual(new Set(keys.map(key => key.projectId)));
      expect(await queue.claim()).toBeNull();
      expect(await new FactoryTransportQueue(new FactoryInstallationCommandOutbox(fixture.db, "foreign"), new FactoryInbox(fixture.db, "foreign")).claim()).toBeNull();
      for (const claim of claims) {
        expect(claim!.command.kind).toBe("decision");
        await expect(queue.settle({ ...claim!, command: { ...claim!.command, projectId: "foreign" } }, "delivered")).rejects.toThrow("factory_command_conflict");
        await expect(outbox.settle({ tenantId: "foreign" } as never, "delivered")).rejects.toThrow("factory_command_scope_mismatch");
        expect(await queue.confirmInboxIdentity(claim!.command)).toBe(false);
      }
      await queue.settle(claims[0]!, "delivered");
      now += 60_001;
      expect(await queue.claim()).toBeNull();
      await expect(queue.settle(claims[1]!, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
      expect((await outbox.inspect(claims[1]!.command.commandId, claims[1]!.command.projectId))?.state).toBe("outcome_unknown");
      const pool = new FactoryInstallationCommandOutbox(fixture.db, inbox.tenantId, () => now, "pool");
      expect((await pool.claim())?.command.kind).toBe("compute_admission");
    });

    test("scope, wire limits and unsafe counters fail before accepted work", async () => {
      const key = await run();
      expect(() => new FactoryInbox(fixture.db, "")).toThrow("factory_identity_invalid");
      await expect(inbox.enqueue({ ...key, runId: "missing" }, event("scope"))).rejects.toMatchObject({ code: "factory_inbox_scope" });
      await expect(inbox.enqueue({ ...key, interpreterId: "" }, event("scope"))).rejects.toThrow("factory_identity_invalid");
      await expect(inbox.enqueue(key, { ...event("bad-time"), atMs: -1 })).rejects.toMatchObject({ code: "factory_inbox_event_invalid" });
      await expect(inbox.enqueue(key, event("bad-kind"), "bad" as "decision")).rejects.toMatchObject({ code: "factory_inbox_event_invalid" });
      await expect(inbox.enqueue(key, { ...event("oversized"), reason: "x".repeat(65_536) })).rejects.toThrow("factory_payload_too_large");
      await expect(inbox.commitTransition(audit(key, { ...proof(event("bad")), inboxSequence: 0 }))).rejects.toMatchObject({ code: "factory_inbox_sequence_invalid" });
      await expect(inbox.commitTransition(audit(key, { ...proof(event("bad")), eventHash: "bad" }))).rejects.toMatchObject({ code: "factory_inbox_identity_invalid" });
      await inbox.enqueue(key, event("counter"));
      await fixture.db.execute(sql`UPDATE factory_inbox_cursors SET next_sequence=${Number.MAX_SAFE_INTEGER} WHERE run_id=${key.runId}`);
      await expect(inbox.enqueue(key, event("unsafe"))).rejects.toMatchObject({ code: "factory_inbox_sequence_invalid" });
    });
  });
}
