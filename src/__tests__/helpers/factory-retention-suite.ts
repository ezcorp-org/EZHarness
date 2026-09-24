import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FACTORY_RETENTION_PERIOD_MS } from "../../db/migrations/add-factory-recovery";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestBytes } from "../../extensions/v4/blobs";
import { archiveFactoryRunAudit, importFactoryArchivedRunAudit, readFactoryArchivedRunAudit, readFactoryRunAudit } from "../../factory/audit-archive";
import { InstallationDataKey, StaticMasterKeyProvider } from "../../factory/encryption";
import { DatabaseInstallationKeyWrapStore } from "../../factory/encryption-key-wrap-store";
import type { FactoryPrincipal } from "../../factory/grants";
import { FactoryRecordError, FactoryRecords, type FactoryAuditBatch } from "../../factory/records";
import { writeFactoryRecoveryJson, type FactoryRecoveryArchive } from "../../factory/recovery-archive";
import type { FactoryReleaseArchive } from "../../factory/releases";
import { factoryRetentionSubjectId, FactoryRetention, FactoryRetentionError, type FactoryRetentionBlobEraser } from "../../factory/retention";
import { createFactoryReleaseWorld, digest, type FactoryReleaseWorld } from "./factory-release-world";

/** What each backend supplies: a migrated database and the independent archive it writes to. */
export interface FactoryRetentionFixture {
  readonly db: TransactionalDb;
  readonly archive: FactoryRecoveryArchive;
  readonly releaseArchive: FactoryReleaseArchive;
  /** Writes one candidate's bytes to the ordinary store and returns its raw digest. */
  putCandidate(bytes: Uint8Array): Promise<string>;
  /** Whether the ordinary store still serves the candidate's current version. */
  candidateReadable(blobDigest: string): Promise<boolean>;
  readonly eraser: FactoryRetentionBlobEraser;
  close(): Promise<void>;
}

const DAY = 86_400_000;

export function factoryRetentionConformance(label: string, createFixture: () => Promise<FactoryRetentionFixture>): void {
  describe(`${label}: C06 reference-aware retention`, () => {
    const tenantId = `retention-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const projectId = "retention-project";
    const installationId = "retention-installation";
    const admin: FactoryPrincipal = { kind: "user", id: `${tenantId}-admin`, authentication: "session" };
    let fixture: FactoryRetentionFixture;
    let records: FactoryRecords;
    let world: FactoryReleaseWorld;
    // Anchors come from database timestamps, so the test clock starts at the
    // real time and every later move is an explicit jump, never a wait.
    let clock = Date.now();
    const now = () => clock;
    let retention: FactoryRetention;
    let failingArchive = false;

    async function terminalRun(runId: string, status: string, audits: number, anchorMs = clock): Promise<FactoryAuditBatch[]> {
      await records.createRun({ projectId, runId, definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
      await fixture.db.execute(sql`INSERT INTO factory_run_lifecycle(tenant_id,project_id,run_id,factory_id,factory_version,definition_digest,grant_revision,status,deadline_ms,parameters_json,parameters_digest,updated_at)
        VALUES (${tenantId},${projectId},${runId},'retention-factory','v1',${digest("d")},1,${status},${clock + DAY},'{}',${digest("e")},to_timestamp(${anchorMs}::double precision / 1000))`);
      const batches: FactoryAuditBatch[] = [];
      for (let index = 1; index <= audits; index += 1) {
        batches.push(await records.appendAudit({ projectId, runId, interpreterId: "root", sourceSequence: index, predecessorDigest: batches.at(-1)?.digest ?? null, payload: { step: index } }));
      }
      return batches;
    }

    async function candidate(runId: string, objectId: string, bytes: Uint8Array, contentDigest = digest("9")): Promise<string> {
      const blob = await fixture.putCandidate(bytes);
      await fixture.db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,candidate_node_instance_id,candidate_generation,digest,blob_digest,storage_version,encoded_bytes) VALUES (${objectId},${tenantId},${projectId},${runId},'candidate_output',${objectId},0,${contentDigest},${blob},'version-1',${bytes.byteLength})`);
      return blob;
    }

    beforeAll(async () => {
      fixture = await createFixture();
      records = new FactoryRecords(fixture.db, tenantId);
      world = await createFactoryReleaseWorld({ database: fixture.db, tenantId, projectId, admin, archive: fixture.releaseArchive, now });
      await fixture.db.execute(sql`INSERT INTO factory_drafts(tenant_id,project_id,factory_id,revision,source_digest,source_json,required_resources_json,requirements_complete,validation_diagnostic_count) VALUES (${tenantId},${projectId},'retention-factory',1,${digest("d")},'{}','[]',TRUE,0)`);
      await fixture.db.execute(sql`INSERT INTO factory_versions(tenant_id,project_id,factory_id,version,draft_revision,definition_digest,compiled_blob_digest,compiled_bytes,lock_json) VALUES (${tenantId},${projectId},'retention-factory','v1',1,${digest("d")},${"b".repeat(64)},1,'{}')`);
      const archive: FactoryRecoveryArchive = {
        write: (...args) => { if (failingArchive) throw new Error("archive unavailable"); return fixture.archive.write(...args); },
        read: (...args) => { if (failingArchive) throw new Error("archive unavailable"); return fixture.archive.read(...args); },
        list: (...args) => fixture.archive.list(...args),
      };
      retention = new FactoryRetention({ database: fixture.db, tenantId, installationId, archive, releaseArchive: fixture.releaseArchive, eraser: fixture.eraser, now });
    });
    afterAll(async () => { await fixture?.close(); });

    test("only terminal subjects enroll, each once, with its class period from its anchor", async () => {
      await terminalRun("run-done", "succeeded", 3);
      await terminalRun("run-live", "running", 1);
      await candidate("run-done", "candidate-done", new TextEncoder().encode("unaccepted candidate"));
      const wraps = new DatabaseInstallationKeyWrapStore(fixture.db);
      const first = new StaticMasterKeyProvider({ id: "master-1", bytes: new Uint8Array(32).fill(1) });
      const key = await InstallationDataKey.loadOrCreate(installationId, wraps, first);
      const second = new StaticMasterKeyProvider({ id: "master-2", bytes: new Uint8Array(32).fill(2) }, [{ id: "master-1", bytes: new Uint8Array(32).fill(1) }, { id: "master-2", bytes: new Uint8Array(32).fill(2) }]);
      await key.rotate(wraps, second);
      const released = await world.acceptRun("run-released");
      await released.release("one");
      expect(await retention.enroll()).toBe(4);
      expect(await retention.enroll()).toBe(0);
      const audit = (await retention.read("run_audit", factoryRetentionSubjectId(projectId, "run-done")))!;
      expect(audit).toMatchObject({ retentionClass: "canonical_audit", state: "retained", archive: null, runId: "run-done" });
      expect(audit.retainUntilMs - audit.anchoredAtMs).toBe(FACTORY_RETENTION_PERIOD_MS.canonical_audit);
      expect((await retention.read("candidate_artifact", factoryRetentionSubjectId(projectId, "candidate-done")))!.retentionClass).toBe("unaccepted_candidate");
      expect((await retention.read("key_wrap", "1"))!.retentionClass).toBe("key_version");
      expect(await retention.read("key_wrap", "2")).toBeNull();
      expect(await retention.read("run_audit", factoryRetentionSubjectId(projectId, "run-live"))).toBeNull();
      expect((await retention.summary()).reduce((total, row) => total + row.count, 0)).toBe(4);
      await expect(retention.enroll(0)).rejects.toMatchObject({ code: "factory_retention_invalid" });
    });

    test("terminal audit streams and settled releases are archived early, long before their deadline", async () => {
      expect(await retention.archivePending()).toBe(2);
      expect(await retention.archivePending()).toBe(0);
      const audit = (await retention.read("run_audit", factoryRetentionSubjectId(projectId, "run-done")))!;
      expect(audit.archive?.key).toContain("/.recovery/audit/");
      expect((await readFactoryArchivedRunAudit(fixture.archive, audit.archive!, tenantId, { projectId, runId: "run-done" })).map(batch => batch.sequence)).toEqual([1, 2, 3]);
      await expect(retention.archivePending(0)).rejects.toMatchObject({ code: "factory_retention_invalid" });
    });

    test("a release extends a deadline and nothing shortens it below the class period", async () => {
      const id = factoryRetentionSubjectId(projectId, "run-done");
      const before = (await retention.read("run_audit", id))!;
      const extended = await retention.extend("run_audit", id, before.retainUntilMs + 30 * DAY, "release retention");
      expect(extended.retainUntilMs).toBe(before.retainUntilMs + 30 * DAY);
      expect((await retention.extend("run_audit", id, before.anchoredAtMs + DAY, "shorter")).retainUntilMs).toBe(extended.retainUntilMs);
      await expect((async () => fixture.db.execute(sql`UPDATE factory_retention_records SET retain_until_ms = anchored_at_ms + 1 WHERE tenant_id = ${tenantId} AND subject_id = ${id}`))()).rejects.toThrow();
      await expect(retention.extend("run_audit", "missing", 1, "x")).rejects.toMatchObject({ code: "factory_retention_not_found" });
      await expect(retention.extend("run_audit", id, -1, "x")).rejects.toMatchObject({ code: "factory_retention_invalid" });
    });

    test("nothing is collected before its deadline, and an archive failure stops the whole pass", async () => {
      expect(await retention.collectDue()).toEqual([]);
      clock += 400 * DAY;
      failingArchive = true;
      await expect(retention.collectDue()).rejects.toMatchObject({ code: "factory_retention_archive_failed" });
      expect((await retention.summary()).every(row => row.state === "retained")).toBe(true);
      expect(await readFactoryRunAudit(records, { projectId, runId: "run-done" })).toHaveLength(3);
      failingArchive = false;
      await expect(retention.collectDue(0)).rejects.toMatchObject({ code: "factory_retention_invalid" });
    });

    test("a live reference keeps a due subject; the catalog names foreign-key referrers", async () => {
      await terminalRun("run-referenced", "failed", 2, clock - 400 * DAY);
      await fixture.db.execute(sql`INSERT INTO factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES (${tenantId},${projectId},'run-referenced','root','command-1',1,${digest("a")})`);
      const executing = await world.acceptRun("run-executing");
      await executing.claimOnly("in-flight");
      await fixture.db.execute(sql`INSERT INTO factory_run_lifecycle(tenant_id,project_id,run_id,factory_id,factory_version,definition_digest,grant_revision,status,deadline_ms,parameters_json,parameters_digest,updated_at)
        VALUES (${tenantId},${projectId},'run-executing','retention-factory','v1',${digest("d")},1,'succeeded',${clock},'{}',${digest("e")},to_timestamp(${clock - 400 * DAY}::double precision / 1000))`);
      await retention.enroll();
      const outcomes = await retention.collectDue();
      const byId = new Map(outcomes.map(outcome => [`${outcome.subjectKind}:${outcome.subjectId}`, outcome]));
      expect(byId.get(`run_audit:${factoryRetentionSubjectId(projectId, "run-referenced")}`)).toMatchObject({ action: "refused", reason: "referenced_by:factory_transition_commands" });
      expect(byId.get(`run_audit:${factoryRetentionSubjectId(projectId, "run-executing")}`)).toMatchObject({ action: "refused", reason: "release_unsettled" });
      expect(byId.get(`run_audit:${factoryRetentionSubjectId(projectId, "run-done")}`)).toMatchObject({ action: "collected" });
      expect(byId.get(`candidate_artifact:${factoryRetentionSubjectId(projectId, "candidate-done")}`)).toMatchObject({ action: "collected" });
      expect(byId.get("key_wrap:1")).toMatchObject({ action: "collected" });
      expect([...byId.values()].find(outcome => outcome.subjectKind === "release")).toMatchObject({ action: "tombstoned", reason: "immutable_fact_retained_until_purge" });
      expect((await retention.read("run_audit", factoryRetentionSubjectId(projectId, "run-referenced")))).toMatchObject({ state: "retained", lastRefusal: "referenced_by:factory_transition_commands" });
      expect(await readFactoryRunAudit(records, { projectId, runId: "run-referenced" })).toHaveLength(2);
    });

    test("an expired audit stream is gone from the database and the full run view rebuilds from the archive", async () => {
      const key = { projectId, runId: "run-done" };
      expect(await readFactoryRunAudit(records, key)).toHaveLength(0);
      expect(rows(await fixture.db.execute(sql`SELECT 1 FROM factory_run_projections WHERE tenant_id = ${tenantId} AND run_id = 'run-done'`))).toHaveLength(0);
      const subject = (await retention.read("run_audit", factoryRetentionSubjectId(projectId, "run-done")))!;
      expect(subject.state).toBe("collected");
      const archived = await readFactoryArchivedRunAudit(fixture.archive, subject.archive!, tenantId, key);
      expect(archived.map(batch => batch.payload)).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
      expect(await importFactoryArchivedRunAudit(fixture.db, records, archived)).toBe(3);
      expect(await importFactoryArchivedRunAudit(fixture.db, records, archived)).toBe(0);
      const restored = await readFactoryRunAudit(records, key);
      expect(restored.map(batch => batch.digest)).toEqual(archived.map(batch => batch.digest));
      // The imported rows read back through the verifying point reader exactly as archived.
      expect(await fixture.db.transaction(transaction => records.readAuditBatchInTransaction(transaction, { ...key, interpreterId: "root" }, 2))).toEqual(archived[1]!);
      expect(await fixture.db.transaction(transaction => records.readAuditBatchInTransaction(transaction, { ...key, interpreterId: "root" }, 9))).toBeNull();
      let view: unknown = null;
      for (const batch of restored) view = (await records.project(batch, "retention-view", (current, next) => ({ steps: [...((current as { steps?: unknown[] } | null)?.steps ?? []), next.payload] }))).payload;
      expect(view).toEqual({ steps: [{ step: 1 }, { step: 2 }, { step: 3 }] });
      // A collected subject is a tombstone: enrollment never resurrects it.
      expect(await retention.enroll()).toBe(0);
    });

    test("a gapped, reordered, or conflicting archived stream stops the rebuild", async () => {
      const key = { projectId, runId: "run-referenced" };
      const archived = await archiveFactoryRunAudit(records, fixture.archive, key);
      const batches = await readFactoryArchivedRunAudit(fixture.archive, archived.index, tenantId, key);
      const forge = async (pages: readonly FactoryAuditBatch[][], through = batches.length, head = batches.at(-1)!.digest) => {
        const refs = [];
        for (const page of pages) refs.push({ first: page[0]!.sequence, last: page.at(-1)!.sequence, object: await writeFactoryRecoveryJson(fixture.archive, tenantId, "audit", "forged", { schemaVersion: "factory.audit-archive.v1", tenantId, projectId, runId: key.runId, batches: page }) });
        return writeFactoryRecoveryJson(fixture.archive, tenantId, "audit", "forged", { schemaVersion: "factory.audit-archive.v1", tenantId, projectId, runId: key.runId, throughSequence: through, headDigest: head, pages: refs });
      };
      await expect(readFactoryArchivedRunAudit(fixture.archive, await forge([[batches[1]!]], 1, batches[1]!.digest), tenantId, key)).rejects.toMatchObject({ code: "factory_audit_gap" });
      await expect(readFactoryArchivedRunAudit(fixture.archive, await forge([[{ ...batches[0]!, payload: { step: "forged" } }, batches[1]!]]), tenantId, key)).rejects.toMatchObject({ code: "factory_audit_corrupt" });
      await expect(readFactoryArchivedRunAudit(fixture.archive, await forge([[batches[0]!, { ...batches[0]!, sequence: 2 }]], 2, batches[0]!.digest), tenantId, key)).rejects.toMatchObject({ code: "factory_audit_conflict" });
      await expect(readFactoryArchivedRunAudit(fixture.archive, await forge([[batches[0]!]], 2), tenantId, key)).rejects.toMatchObject({ code: "factory_audit_gap" });
      await expect(readFactoryArchivedRunAudit(fixture.archive, archived.index, tenantId, { projectId, runId: "other" })).rejects.toBeInstanceOf(FactoryRecordError);
      // A database row that disagrees with the archive is a conflict, never an overwrite.
      const altered = { ...batches[0]!, payload: { step: "altered" } };
      await expect(importFactoryArchivedRunAudit(fixture.db, records, [altered])).rejects.toMatchObject({ code: "factory_audit_corrupt" });
      await expect(importFactoryArchivedRunAudit(fixture.db, records, [{ ...batches[1]!, sequence: 5 }])).rejects.toBeInstanceOf(FactoryRecordError);
    });

    test("an unaccepted candidate is erased after ninety days unless its bytes are shared or it was released", async () => {
      await terminalRun("run-candidates", "succeeded", 1, clock - 91 * DAY);
      const shared = new TextEncoder().encode("shared bytes");
      const blob = await candidate("run-candidates", "candidate-shared-a", shared, digest("1"));
      await candidate("run-candidates", "candidate-shared-b", shared, digest("2"));
      const released = await candidate("run-candidates", "candidate-released", new TextEncoder().encode("released bytes"), digest("c"));
      await retention.enroll();
      const outcomes = await retention.collectDue();
      const find = (objectId: string) => outcomes.find(outcome => outcome.subjectKind === "candidate_artifact" && outcome.subjectId === factoryRetentionSubjectId(projectId, objectId));
      expect(find("candidate-shared-a")).toMatchObject({ action: "tombstoned", reason: "blob_shared" });
      expect(find("candidate-shared-b")).toMatchObject({ action: "tombstoned", reason: "blob_shared" });
      expect(find("candidate-released")).toMatchObject({ action: "refused", reason: "released_candidate" });
      expect(await fixture.candidateReadable(blob)).toBe(true);
      expect(await fixture.candidateReadable(released)).toBe(true);
      const done = rows<{ blob_digest: string }>(await fixture.db.execute(sql`SELECT blob_digest FROM factory_artifacts WHERE tenant_id = ${tenantId} AND object_id = 'candidate-done'`))[0]!;
      expect(done.blob_digest).toBe(digestBytes(new TextEncoder().encode("unaccepted candidate")));
      expect(await fixture.candidateReadable(done.blob_digest)).toBe(false);
      expect((await retention.read("candidate_artifact", factoryRetentionSubjectId(projectId, "candidate-done")))!.state).toBe("collected");
    });

    test("a superseded key wrap is kept while a sealed checkpoint needs it, and the current wrap is never collected", async () => {
      expect((await retention.read("key_wrap", "1"))!.state).toBe("collected");
      const wraps = new DatabaseInstallationKeyWrapStore(fixture.db);
      const second = { id: "master-2", bytes: new Uint8Array(32).fill(2) }, third = { id: "master-3", bytes: new Uint8Array(32).fill(3) };
      const key = await InstallationDataKey.loadExisting(installationId, wraps, new StaticMasterKeyProvider(second));
      await key.rotate(wraps, new StaticMasterKeyProvider(third, [second, third]));
      await fixture.db.execute(sql`INSERT INTO factory_checkpoints(tenant_id,checkpoint_id,state,execution_epoch,key_wrap_version,started_at_ms,duration_ms,product_lsn,manifest_digest,manifest_archive_json,sealed_at)
        VALUES (${tenantId},'retention-checkpoint','sealed',1,2,0,5,'0/1',${digest("a")},'{}',to_timestamp(${clock}::double precision / 1000))`);
      await retention.enroll();
      expect((await retention.read("key_wrap", "2"))!.state).toBe("retained");
      expect((await retention.collectDue()).find(item => item.subjectId === "2")).toMatchObject({ subjectKind: "key_wrap", action: "refused", reason: "checkpoint_needs_key_wrap" });
      clock += 366 * DAY;
      expect((await retention.collectDue()).find(item => item.subjectId === "2")).toMatchObject({ subjectKind: "key_wrap", action: "collected" });
      expect((await InstallationDataKey.loadExisting(installationId, wraps, new StaticMasterKeyProvider(third))).wrapVersion).toBe(3);
      await fixture.db.execute(sql`INSERT INTO factory_retention_records(tenant_id,subject_kind,subject_id,retention_class,anchored_at_ms,retain_until_ms) VALUES (${tenantId},'key_wrap','3','key_version',0,${FACTORY_RETENTION_PERIOD_MS.key_version})`);
      expect((await retention.collectDue()).find(item => item.subjectId === "3")).toMatchObject({ subjectKind: "key_wrap", action: "refused", reason: "current_key_wrap" });
    });

    test("a settled release is tombstoned at its deadline and never deleted, with its archive copy verified", async () => {
      const [record] = rows<{ subject_id: string }>(await fixture.db.execute(sql`SELECT subject_id FROM factory_retention_records WHERE tenant_id = ${tenantId} AND subject_kind = 'release'`));
      const release = (await retention.read("release", record!.subject_id))!;
      expect(release).toMatchObject({ state: "tombstoned", lastRefusal: "immutable_fact_retained_until_purge" });
      expect(release.archive?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(rows(await fixture.db.execute(sql`SELECT 1 FROM factory_release_operations WHERE tenant_id = ${tenantId} AND state = 'succeeded'`)).length).toBeGreaterThan(0);
    });

    test("two concurrent passes collect each subject once", async () => {
      await terminalRun("run-race", "cancelled", 2);
      clock += 400 * DAY;
      await retention.enroll();
      const [left, right] = await Promise.all([retention.collectDue(), retention.collectDue()]);
      const collected = [...left, ...right].filter(outcome => outcome.subjectKind === "run_audit" && outcome.subjectId === factoryRetentionSubjectId(projectId, "run-race") && outcome.action === "collected");
      expect(collected).toHaveLength(1);
      expect((await retention.read("run_audit", factoryRetentionSubjectId(projectId, "run-race")))!.state).toBe("collected");
    });

    test("validator evidence, approvals, and receipts are kept for their class period, then tombstoned and never deleted", async () => {
      // `run-released` carries accepted evidence and a release approval; it becomes terminal now.
      await fixture.db.execute(sql`INSERT INTO factory_run_lifecycle(tenant_id,project_id,run_id,factory_id,factory_version,definition_digest,grant_revision,status,deadline_ms,parameters_json,parameters_digest,updated_at)
        VALUES (${tenantId},${projectId},'run-released','retention-factory','v1',${digest("d")},1,'succeeded',${clock + DAY},'{}',${digest("e")},to_timestamp(${clock}::double precision / 1000))`);
      // `run-receipt` carries one task completion receipt: execution, output, terminal, command, completion.
      await terminalRun("run-receipt", "succeeded", 1);
      const bare = (fill: string) => fill.repeat(64);
      await fixture.db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES ('attempt-receipt',${tenantId},${projectId},'run-receipt','node-receipt',0,1,1,1,1,0,NOW() + INTERVAL '1 hour',${bare("2")},'{}'::jsonb,'admitted')`);
      await fixture.db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,candidate_node_instance_id,candidate_generation,digest,blob_digest,storage_version,encoded_bytes) VALUES ('output-receipt',${tenantId},${projectId},'run-receipt','candidate_output','node-receipt',0,${digest("5")},${bare("7")},'version-1',64)`);
      await fixture.db.execute(sql`INSERT INTO factory_execution_terminals(tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,request_digest,result_digest,terminal_result_digest,result_json,output_artifact_id,output_digest,output_bytes,execution_epoch,cancellation_epoch,terminal_fact_digest) VALUES (${tenantId},${projectId},'run-receipt','node-receipt',0,'attempt-receipt',${bare("2")},${bare("3")},${digest("4")},'{}','output-receipt',${digest("5")},64,1,0,${digest("6")})`);
      await fixture.db.execute(sql`INSERT INTO factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES (${tenantId},${projectId},'run-receipt','root','task-receipt',1,${digest("8")})`);
      await fixture.db.execute(sql`INSERT INTO factory_task_completions(tenant_id,project_id,run_id,interpreter_id,command_id,attempt_id,input_digest,authority_json,receipt_json,receipt_digest) VALUES (${tenantId},${projectId},'run-receipt','root','task-receipt','attempt-receipt',${digest("9")},'{}','{}',${digest("a")})`);
      await retention.enroll();
      const released = factoryRetentionSubjectId(projectId, "run-released"), receipted = factoryRetentionSubjectId(projectId, "run-receipt");
      for (const [kind, subjectId] of [["accepted_evidence", released], ["approval", released], ["receipt", receipted]] as const) {
        const subject = (await retention.read(kind, subjectId))!;
        expect(subject).toMatchObject({ retentionClass: kind, state: "retained" });
        expect(subject.retainUntilMs - subject.anchoredAtMs).toBe(FACTORY_RETENTION_PERIOD_MS[kind]);
      }
      // A run with none of these facts enrolls none of them.
      expect(await retention.read("receipt", released)).toBeNull();
      expect(await retention.read("approval", receipted)).toBeNull();
      clock += 366 * DAY;
      const outcomes = await retention.collectDue();
      for (const [kind, subjectId] of [["accepted_evidence", released], ["approval", released], ["receipt", receipted]] as const) {
        expect(outcomes.find(outcome => outcome.subjectKind === kind && outcome.subjectId === subjectId)).toEqual({ subjectKind: kind, subjectId, action: "tombstoned", reason: "immutable_fact_retained_until_purge" });
        expect((await retention.read(kind, subjectId))!.state).toBe("tombstoned");
      }
      expect(rows(await fixture.db.execute(sql`SELECT 1 FROM factory_acceptance_evidence WHERE tenant_id = ${tenantId} AND run_id = 'run-released'`)).length).toBe(1);
      expect(rows(await fixture.db.execute(sql`SELECT 1 FROM factory_release_approvals WHERE tenant_id = ${tenantId}`)).length).toBeGreaterThan(0);
      expect(rows(await fixture.db.execute(sql`SELECT 1 FROM factory_task_completions WHERE tenant_id = ${tenantId} AND run_id = 'run-receipt'`)).length).toBe(1);
    });

    test("a cancelled pass stops before its next subject", async () => {
      const controller = new AbortController();
      controller.abort(new FactoryRetentionError("factory_retention_invalid"));
      await terminalRun("run-cancelled-pass", "succeeded", 1);
      clock += 400 * DAY;
      await retention.enroll();
      await expect(retention.collectDue(200, controller.signal)).rejects.toMatchObject({ code: "factory_retention_invalid" });
      expect((await retention.read("run_audit", factoryRetentionSubjectId(projectId, "run-cancelled-pass")))!.state).toBe("retained");
    });
  });
}
