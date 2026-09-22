import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { referenceCodeV1, type FactoryDefinition, type FactoryInspectionPage, type FactoryRunInspection, type FactoryRunStartBody } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { BlobStore } from "../../extensions/v4/types";
import { createFactoryApplication, type FactoryApplication } from "../../factory/application";
import { createFactoryConsole, type FactoryConsoleServices } from "../../factory/console";
import type { FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import { FACTORY_RUN_STATUS_CONSUMER_ID } from "../../factory/run-transition-projector";
import { canonicalJson } from "@ezcorp/extension-contract";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import { factoryPackageTestReference as packageReference, factoryPackageTestRelease } from "./factory-package-preparation-suite";

/** Narrows an inspection to the one section page it must be. */
function sectionPage<Item>(result: FactoryRunInspection | FactoryInspectionPage): { items: Item[]; nextCursor?: string } {
  if (!("section" in result)) throw new Error("expected a section page");
  return result.page as unknown as { items: Item[]; nextCursor?: string };
}

export interface FactoryConsoleFixture { readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void> }

const PROJECT = "console-project";
const OTHER_PROJECT = "console-other";
const FACTORY = "console-factory";
const OWNER: FactoryPrincipal = { kind: "user", id: "console-owner", authentication: "session" };
const MEMBER: FactoryPrincipal = { kind: "user", id: "console-member", authentication: "session" };
const OUTSIDER: FactoryPrincipal = { kind: "user", id: "console-outsider", authentication: "session" };
const hex = (label: string) => createHash("sha256").update(label).digest("hex");
const sha = (label: string) => `sha256:${hex(label)}`;

export interface ConsoleInstallation {
  readonly fixture: FactoryConsoleFixture;
  readonly tenantId: string;
  readonly application: FactoryApplication;
  readonly console: FactoryConsoleServices;
  readonly runId: string;
  readonly childRunId: string;
  readonly artifactId: string;
  readonly clock: { now: number };
}

async function seedUsers(db: MigrationDb): Promise<void> {
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${PROJECT}, 'Console', '/tmp/console'), (${OTHER_PROJECT}, 'Other', '/tmp/console-other')`);
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES
    (${OWNER.id}, 'owner@console.test', 'x', 'Owner', 'admin'), (${MEMBER.id}, 'member@console.test', 'x', 'Member', 'user'), (${OUTSIDER.id}, 'outsider@console.test', 'x', 'Outsider', 'user')`);
  await db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES
    ('console-owner-member', ${PROJECT}, ${OWNER.id}, 'owner'), ('console-member-member', ${PROJECT}, ${MEMBER.id}, 'viewer'), ('console-owner-other', ${OTHER_PROJECT}, ${OWNER.id}, 'owner')`);
}

/** One provisioned installation: its own database, tenant, key, users, and a run with every console section populated. */
export async function provisionConsoleInstallation(create: () => Promise<FactoryConsoleFixture>, tenantId: string, keyByte: number): Promise<ConsoleInstallation> {
  const fixture = await create();
  const clock = { now: 1_900_000_000_000 };
  const records = new FactoryRecords(fixture.db, tenantId);
  await records.bindInstallation();
  await seedUsers(fixture.db);
  const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: FACTORY, inputPorts: {}, outputPorts: {}, graph: { nodes: [], outputs: {} } };
  const application = createFactoryApplication({
    database: fixture.db, tenantId, blobs: fixture.blobs, availableResourceClasses: [],
    runOptions: { interpreterBuild: "console-build", interpreterCompatibility: source.interpreterCompatibility, limits: { maxCostMicros: "5000", maxTokens: 100, maxComputeMs: 100 } },
    consoleKey: async () => new Uint8Array(32).fill(keyByte + 100),
  });
  for (const project of [PROJECT, OTHER_PROJECT]) await fixture.db.transaction(transaction => application.grants.initializeProjectInTransaction(transaction, project, OWNER.id));
  await application.definitions.save(OWNER, { projectId: PROJECT, factoryId: FACTORY }, 0, "console-save", source);
  const version = await application.definitions.publish(OWNER, { projectId: PROJECT, factoryId: FACTORY }, 1, "console-publish");
  const body: FactoryRunStartBody = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: {} };
  const runId = (await application.runs.start(OWNER, { projectId: PROJECT, factoryId: FACTORY }, body, 0, "console-start")).run.runId;
  const childRunId = (await application.runs.start(OWNER, { projectId: PROJECT, factoryId: FACTORY }, body, 0, "console-child")).run.runId;
  // The suite's own clock drives expiry; the application's composition is proven separately.
  const consoleServices = createFactoryConsole({ database: fixture.db, tenantId, grants: application.grants, runs: application.runs, artifacts: application.artifacts, blobs: fixture.blobs, key: new Uint8Array(32).fill(keyByte), now: () => clock.now });
  const installation = { fixture, tenantId, application, console: consoleServices, runId, childRunId, artifactId: "", clock };
  return { ...installation, artifactId: await seedSections(installation) };
}

/** Writes every inspected section through its real tables and foreign keys. */
async function seedSections(installation: Omit<ConsoleInstallation, "artifactId">): Promise<string> {
  const { fixture, tenantId, runId, childRunId } = installation;
  const records = new FactoryRecords(fixture.db, tenantId);
  let predecessor: string | null = null;
  for (const sourceSequence of [1, 2, 3]) {
    const batch = await records.appendAudit({ projectId: PROJECT, runId, interpreterId: "root", sourceSequence, predecessorDigest: predecessor, payload: { transition: sourceSequence, note: sourceSequence === 3 ? "x".repeat(20_000) : "small" } });
    predecessor = batch.digest;
    if (sourceSequence === 1) await records.project(batch, FACTORY_RUN_STATUS_CONSUMER_ID, () => ({ status: "running" }));
  }
  const artifact = await fixture.db.transaction(transaction => installation.application.artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId: PROJECT, logicalRunId: runId, interpreterId: "root" }, "work", 0, new TextEncoder().encode("<script>alert('x')</script>")));
  await fixture.db.transaction(async transaction => {
    const scope = { tenant: tenantId, project: PROJECT, run: runId };
    await transaction.execute(sql`INSERT INTO factory_transition_commands (tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES
      (${scope.tenant},${scope.project},${scope.run},'root','cmd-child',1,${sha("cmd-child")}), (${scope.tenant},${scope.project},${scope.run},'root','cmd-accept',2,${sha("cmd-accept")}), (${scope.tenant},${scope.project},${scope.run},'root','cmd-stop',3,${sha("cmd-stop")})`);
    const [parentEnvelope] = rows<{ envelope_id: string }>(await transaction.execute(sql`SELECT envelope_id FROM factory_budget_envelopes WHERE tenant_id=${tenantId} AND project_id=${PROJECT} AND run_id=${runId} AND parent_id IS NULL`));
    const [childEnvelope] = rows<{ envelope_id: string }>(await transaction.execute(sql`SELECT envelope_id FROM factory_budget_envelopes WHERE tenant_id=${tenantId} AND project_id=${PROJECT} AND run_id=${childRunId} AND parent_id IS NULL`));
    await transaction.execute(sql`UPDATE factory_budget_envelopes SET admission_blocked=true WHERE tenant_id=${tenantId} AND project_id=${PROJECT} AND run_id=${runId} AND envelope_id=${parentEnvelope!.envelope_id}`);
    await transaction.execute(sql`INSERT INTO factory_child_runs (tenant_id,project_id,parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state,started_ms,definition_json)
      VALUES (${tenantId},${PROJECT},${runId},'root','cmd-child',1,${sha("cmd-child")},${childRunId},${parentEnvelope!.envelope_id},${childEnvelope!.envelope_id},${FACTORY},'1.0.0',${sha("child-def")},1,0,1,${installation.clock.now + 60_000},${sha("binding")},'open',${installation.clock.now},'{}')`);
    for (const [attemptId, node, number, status] of [["attempt-b1", "node-b", 1, "failed"], ["attempt-a1", "node-a", 1, "completed"], ["attempt-a2", "node-a", 2, "running"]] as const) {
      await transaction.execute(sql`INSERT INTO factory_executions (attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
        VALUES (${`${tenantId}-${attemptId}`},${tenantId},${PROJECT},${runId},${node},0,${number},1,1,1,0,NOW(),${hex(attemptId)},${JSON.stringify({ runner: { digest: "sha256:pkg" } })}::jsonb,${status})`);
    }
    await transaction.execute(sql`INSERT INTO factory_execution_terminals (tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,request_digest,result_digest,terminal_result_digest,result_json,output_artifact_id,output_digest,output_bytes,execution_epoch,cancellation_epoch,terminal_fact_digest)
      VALUES (${tenantId},${PROJECT},${runId},'node-a',0,${`${tenantId}-attempt-a1`},${hex("req")},${hex("result")},${sha("terminal")},'{}',${artifact.artifactId},${artifact.digest},${artifact.encodedBytes},1,0,${sha("fact")})`);
    await transaction.execute(sql`INSERT INTO factory_command_approvals (tenant_id,project_id,approval_id,run_id,interpreter_id,command_id,source_sequence,source_digest,node_instance_id,candidate_generation,attempt,definition_digest,execution_epoch,cancellation_epoch,initiator_kind,initiator_id,actor_scope,choices_json,context_json,deadline_at_ms,context_digest,protected_digest,status)
      VALUES (${tenantId},${PROJECT},'approval-1',${runId},'root','cmd-approve',1,${hex("source")},'node-a',0,1,${sha("definition")},1,0,'user',${OWNER.id},'owner','["yes","no"]','{}',${installation.clock.now + 60_000},${hex("context")},${sha("protected")},'pending')`);
    await transaction.execute(sql`INSERT INTO factory_budget_reservations (tenant_id,project_id,run_id,reservation_id,envelope_id,request_digest,amount,state) VALUES
      (${tenantId},${PROJECT},${runId},'reservation-1',${parentEnvelope!.envelope_id},${sha("reservation-1")},'{}','settled'), (${tenantId},${PROJECT},${runId},'reservation-2',${parentEnvelope!.envelope_id},${sha("reservation-2")},'{}','held')`);
    await transaction.execute(sql`INSERT INTO factory_compute_admissions (tenant_id,project_id,run_id,reservation_id,request_digest,request_json,state,next_poll_at) VALUES (${tenantId},${PROJECT},${runId},'reservation-2',${sha("admission")},'{}','queued',0)`);
    for (const [revision, known, unknown] of [[1, "100", null], [2, "250", "7"]] as const) {
      await transaction.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,settled_at_ms,settlement_digest,event_json,event_digest)
        VALUES (${tenantId},${PROJECT},${runId},'reservation-1',${revision},${`${tenantId}-attempt-a1`},'stop',${known},${unknown},${installation.clock.now},${sha(`settle-${revision}`)},'{}',${sha(`event-${revision}`)})`);
    }
    const rejected = { outcome: "rejected", candidateDigest: sha("candidate"), failures: [{ claimId: "tests-pass", validatorId: "validator.tests", verdict: "FAIL", reasonCode: "TESTS_FAILED" }], groupFailures: [{ groupId: "quality", passes: 1, minimumPasses: 2 }] };
    await transaction.execute(sql`INSERT INTO factory_protected_command_effects (tenant_id,project_id,run_id,interpreter_id,command_id,kind,command_digest,receipt_json,receipt_digest,decision)
      VALUES (${tenantId},${PROJECT},${runId},'root','cmd-accept','request-acceptance',${sha("cmd-accept")},${JSON.stringify(rejected)},${sha("receipt")},'rejected')`);
    await transaction.execute(sql`INSERT INTO factory_acceptance_contracts (tenant_id,project_id,contract_id,revision,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,approved_by,approval_grant_revision,protected_snapshot_digest)
      VALUES (${tenantId},${PROJECT},'contract',1,${sha("contract")},${sha("lock")},'[]','[]',${OWNER.id},1,${sha("snapshot")})`);
    await transaction.execute(sql`INSERT INTO factory_acceptance_decisions (tenant_id,project_id,decision_id,contract_id,contract_revision,contract_digest,candidate_digest,evidence_set_digest,decision_digest,contract_snapshot_digest)
      VALUES (${tenantId},${PROJECT},'decision-1','contract',1,${sha("contract")},${sha("candidate")},${sha("evidence")},${sha("decision")},${sha("snapshot")})`);
    await transaction.execute(sql`INSERT INTO factory_release_operations (tenant_id,project_id,operation_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,contract_digest,execution_epoch,cancellation_epoch,release_enable_epoch,action,destination_provider,destination_account,destination_object,destination_digest,canonical_request,request_digest,material_json,material_digest,estimated_spend_micros,deadline_ms,state,dispatch_generation,outcome_code,profile_input_digest,profile_result_digest,profile_resolved_at_ms)
      VALUES (${tenantId},${PROJECT},'operation-1',${runId},'node-a',0,${sha("candidate")},'decision-1',${sha("contract")},1,0,1,'factory.release.publish','s3','acct','obj',${sha("dest")},'{}',${sha("request")},'{}',${sha("material")},10,${installation.clock.now + 60_000},'uncertain',2,'provider_timeout',${sha("profile-in")},${sha("profile-out")},${installation.clock.now})`);
  });
  return artifact.artifactId;
}

export function factoryConsoleConformance(create: () => Promise<FactoryConsoleFixture>): void {
  let a: ConsoleInstallation;
  let b: ConsoleInstallation;
  const key = () => ({ projectId: PROJECT, runId: a.runId });

  beforeAll(async () => {
    a = await provisionConsoleInstallation(create, "console-tenant-a", 7);
    b = await provisionConsoleInstallation(create, "console-tenant-b", 9);
  }, 120_000);
  afterAll(async () => { await a?.fixture.close(); await b?.fixture.close(); });

  describe("run inspection", () => {
    test("one snapshot carries every section, bounded and scoped to its own tenant", async () => {
      const view = await a.console.inspections.inspect(OWNER, key()) as FactoryRunInspection;
      expect(view.run.runId).toBe(a.runId);
      expect(view.cursor.sequence).toBe(1);
      expect(view.projectionLag).toBe(2);
      expect(view.children.items).toEqual([{ runId: a.childRunId, factoryId: FACTORY, factoryVersion: "1.0.0", state: "open", status: "queued", deadlineMs: a.clock.now + 60_000 }]);
      expect(view.attempts.items.map(item => [item.nodeInstanceId, item.attemptNumber, item.status])).toEqual([["node-a", 1, "completed"], ["node-a", 2, "running"], ["node-b", 1, "failed"]]);
      expect(view.attempts.items[0]).toMatchObject({ resultDigest: hex("result"), outputArtifactId: a.artifactId });
      expect(view.artifacts.items.map(item => item.artifactId)).toContain(a.artifactId);
      expect(view.blockers.map(item => [item.kind, item.id]).sort()).toEqual([["approval", "approval-1"], ["budget", expect.any(String)], ["compute", "reservation-2"], ["release", "operation-1"]].sort());
      expect(view.blockers.find(item => item.kind === "release")!.reason).toContain("uncertain");
      expect(view.costs).toMatchObject({ knownCostMicros: "250", unknownCostMicros: "7", admissionBlocked: true, uncertain: true, limitMicros: "5000" });
      expect(view.acceptance).toEqual([{ commandId: "cmd-accept", decision: "rejected", candidateDigest: sha("candidate"), reasons: [{ claimId: "tests-pass", validatorId: "validator.tests", verdict: "FAIL", reasonCode: "TESTS_FAILED" }], groupFailures: [{ groupId: "quality", passes: 1, minimumPasses: 2 }], decidedAtMs: expect.any(Number) }]);
      expect(view.releases).toEqual([{ operationId: "operation-1", nodeInstanceId: "node-a", state: "uncertain", action: "factory.release.publish", dispatchGeneration: 2, outcomeCode: "provider_timeout" }]);
    });

    test("a child run names its parent", async () => {
      const view = await a.console.inspections.inspect(OWNER, { projectId: PROJECT, runId: a.childRunId }) as FactoryRunInspection;
      expect(view.parentRunId).toBe(a.runId);
      expect(view.children.items).toEqual([]);
    });

    test("sections page by keyset, filter server-side, and refuse a forged or misplaced cursor", async () => {
      const first = await a.console.inspections.inspect(OWNER, key(), { section: "attempts", limit: 2 });
      expect(first).toMatchObject({ section: "attempts" });
      const page = sectionPage<{ attemptId: string }>(first);
      expect(page.items).toHaveLength(2);
      const second = sectionPage<{ nodeInstanceId: string }>(await a.console.inspections.inspect(OWNER, key(), { section: "attempts", limit: 2, cursor: page.nextCursor! }));
      expect(second.items.map(item => item.nodeInstanceId)).toEqual(["node-b"]);
      expect(second.nextCursor).toBeUndefined();
      const filtered = sectionPage(await a.console.inspections.inspect(OWNER, key(), { section: "attempts", search: "node-b" }));
      expect(filtered.items).toHaveLength(1);
      for (const cursor of ["not-base64-json", Buffer.from("[1,2]").toString("base64url"), Buffer.from('{"x":1}').toString("base64url")]) {
        await expect(a.console.inspections.inspect(OWNER, key(), { section: "attempts", cursor })).rejects.toMatchObject({ code: "factory_page_invalid" });
      }
      await expect(a.console.inspections.inspect(OWNER, key(), { cursor: page.nextCursor! })).rejects.toMatchObject({ code: "factory_page_invalid" });
      for (const limit of [0, 201, 1.5]) await expect(a.console.inspections.inspect(OWNER, key(), { limit })).rejects.toMatchObject({ code: "factory_page_invalid" });
      expect(sectionPage(await a.console.inspections.inspect(OWNER, key(), { section: "children", limit: 1 })).items).toHaveLength(1);
      expect(sectionPage(await a.console.inspections.inspect(OWNER, key(), { section: "artifacts", limit: 1 })).items).toHaveLength(1);
    });

    test("current authority is required, and a missing run is not told apart from another project", async () => {
      await expect(a.console.inspections.inspect(OUTSIDER, key())).rejects.toMatchObject({ code: "factory_forbidden" });
      await expect(a.console.inspections.inspect(OWNER, { projectId: PROJECT, runId: "missing-run" })).rejects.toMatchObject({ code: "factory_run_not_found" });
      await expect(a.console.inspections.inspect(OWNER, { projectId: OTHER_PROJECT, runId: a.runId })).rejects.toMatchObject({ code: "factory_run_not_found" });
      const member = await a.console.inspections.inspect(MEMBER, key()) as FactoryRunInspection;
      expect(member.run.runId).toBe(a.runId);
    });

    test("an installation with the same identifiers sees only its own rows", async () => {
      const view = await b.console.inspections.inspect(OWNER, { projectId: PROJECT, runId: b.runId }) as FactoryRunInspection;
      expect(view.run.runId).toBe(b.runId);
      expect(view.attempts.items.every(item => item.attemptId.startsWith("console-tenant-b"))).toBe(true);
      await expect(b.console.inspections.inspect(OWNER, key())).rejects.toMatchObject({ code: "factory_run_not_found" });
    });
  });

  test("the application composes its console once, from the installation key", async () => {
    const composed = await a.application.console();
    expect(await a.application.console()).toBe(composed);
    expect(composed.tenantId).toBe(a.tenantId);
    const view = await composed.inspections.inspect(OWNER, key()) as FactoryRunInspection;
    // The application's key is not the suite's, so its cursor does not open under the suite's signer.
    await expect(a.console.events.read(OWNER, key(), view.cursor.token)).rejects.toMatchObject({ code: "factory_cursor_invalid" });
    expect((await composed.events.read(OWNER, key(), view.cursor.token)).events.length).toBeGreaterThan(0);
  });

  describe("event stream", () => {
    test("streams contiguously from the snapshot cursor, inlines only bounded payloads, and resumes without duplicates", async () => {
      const view = await a.console.inspections.inspect(OWNER, key()) as FactoryRunInspection;
      const first = await a.console.events.read(OWNER, key(), view.cursor.token, 1);
      expect(first.events.map(event => event.sequence)).toEqual([2]);
      expect(first.events[0]!.payload).toEqual({ transition: 2, note: "small" });
      expect(first.events[0]!.eventId).toMatch(/^[0-9a-f]{64}$/);
      const rest = await a.console.events.read(OWNER, key(), first.cursor.token);
      expect(rest.events.map(event => event.sequence)).toEqual([3]);
      expect(rest.events[0]!.payload).toBeUndefined();
      expect(rest.events[0]!.payloadBytes).toBeGreaterThan(16 * 1024);
      const idle = await a.console.events.read(OWNER, key(), rest.cursor.token);
      expect(idle.events).toEqual([]);
      expect(idle.cursor.sequence).toBe(3);
      expect(idle.drained).toBe(false);
      // Replaying an older position serves the same events again; the client dedupes by sequence.
      const replay = await a.console.events.read(OWNER, key(), first.cursor.token);
      expect(replay.events.map(event => event.eventId)).toEqual(rest.events.map(event => event.eventId));
    });

    test("an expired, forged, foreign, or future cursor is refused with its own code", async () => {
      const view = await a.console.inspections.inspect(OWNER, key()) as FactoryRunInspection;
      const [body] = view.cursor.token.split(".");
      await expect(a.console.events.read(OWNER, key(), `${body}.${"A".repeat(43)}`)).rejects.toMatchObject({ code: "factory_cursor_invalid" });
      await expect(a.console.events.read(OWNER, { projectId: PROJECT, runId: a.childRunId }, view.cursor.token)).rejects.toMatchObject({ code: "factory_cursor_invalid" });
      const foreignView = await b.console.inspections.inspect(OWNER, { projectId: PROJECT, runId: b.runId }) as FactoryRunInspection;
      await expect(a.console.events.read(OWNER, { projectId: PROJECT, runId: b.runId }, foreignView.cursor.token)).rejects.toMatchObject({ code: "factory_cursor_invalid" });
      a.clock.now += 16 * 60_000;
      try {
        await expect(a.console.events.read(OWNER, key(), view.cursor.token)).rejects.toMatchObject({ code: "factory_cursor_expired" });
      } finally { a.clock.now -= 16 * 60_000; }
    });

    test("revoking read authority refuses the next batch", async () => {
      const view = await a.console.inspections.inspect(MEMBER, key()) as FactoryRunInspection;
      await a.fixture.db.execute(sql`DELETE FROM project_members WHERE id='console-member-member'`);
      try {
        await expect(a.console.events.read(MEMBER, key(), view.cursor.token)).rejects.toMatchObject({ code: "factory_forbidden" });
      } finally {
        await a.fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('console-member-member', ${PROJECT}, ${MEMBER.id}, 'viewer')`);
      }
    });

    test("batch limits are bounded", async () => {
      const view = await a.console.inspections.inspect(OWNER, key()) as FactoryRunInspection;
      for (const limit of [0, 51]) await expect(a.console.events.read(OWNER, key(), view.cursor.token, limit)).rejects.toMatchObject({ code: "factory_page_invalid" });
    });
  });

  describe("artifact tickets", () => {
    test("a ticket downloads exact bytes for the principal it names, and nothing else", async () => {
      const ticket = await a.console.tickets.issue(OWNER, key(), a.artifactId, "/download");
      expect(ticket.mediaType).toBe("application/octet-stream");
      const token = new URL(ticket.url, "http://x").searchParams.get("ticket")!;
      const download = await a.console.tickets.download(OWNER, key(), a.artifactId, token);
      expect(new TextDecoder().decode(download.bytes)).toBe("<script>alert('x')</script>");
      await expect(a.console.tickets.download(MEMBER, key(), a.artifactId, token)).rejects.toMatchObject({ code: "factory_ticket_invalid" });
      await expect(a.console.tickets.download(OWNER, key(), "other-artifact", token)).rejects.toMatchObject({ code: "factory_ticket_invalid" });
      await expect(b.console.tickets.download(OWNER, key(), a.artifactId, token)).rejects.toMatchObject({ code: "factory_ticket_invalid" });
      await expect(a.console.tickets.issue(OUTSIDER, key(), a.artifactId, "/download")).rejects.toMatchObject({ code: "factory_forbidden" });
      await expect(a.console.tickets.issue(OWNER, key(), "missing", "/download")).rejects.toMatchObject({ code: "factory_artifact_not_found" });
      a.clock.now += 61_000;
      try { await expect(a.console.tickets.download(OWNER, key(), a.artifactId, token)).rejects.toMatchObject({ code: "factory_ticket_expired" }); }
      finally { a.clock.now -= 61_000; }
    });

    test("an event cursor never verifies as a ticket", async () => {
      const view = await a.console.inspections.inspect(OWNER, key()) as FactoryRunInspection;
      await expect(a.console.tickets.download(OWNER, key(), a.artifactId, view.cursor.token)).rejects.toMatchObject({ code: "factory_ticket_invalid" });
    });
  });

  describe("cross-project read sharing", () => {
    test("only the named bytes become readable in the target project, and revocation closes them", async () => {
      const second = await a.fixture.db.transaction(transaction => a.application.artifacts.stageCandidateOutputInTransaction(transaction, { tenantId: a.tenantId, projectId: PROJECT, logicalRunId: a.runId, interpreterId: "root" }, "work", 1, new TextEncoder().encode("not shared")));
      const view = await a.console.inspections.inspect(OWNER, key()) as FactoryRunInspection;
      const shared = view.artifacts.items.find(item => item.artifactId === a.artifactId)!;
      const body = { targetProjectId: OTHER_PROJECT, mediaType: "text/plain" };
      await expect(a.console.tickets.share({ ...OWNER, authentication: "api-key" }, key(), a.artifactId, body, "share-key")).rejects.toMatchObject({ code: "factory_human_required" });
      await expect(a.console.tickets.share(MEMBER, key(), a.artifactId, body, "share-member")).rejects.toMatchObject({ code: "factory_forbidden" });
      const grant = await a.console.tickets.share(OWNER, key(), a.artifactId, body, "share-owner");
      expect(grant).toEqual({ sourceProjectId: PROJECT, sourceRunId: a.runId, artifactId: a.artifactId, targetProjectId: OTHER_PROJECT, digest: shared.digest, encodedBytes: shared.encodedBytes, mediaType: "text/plain", revoked: false });
      expect(await a.console.tickets.share(OWNER, key(), a.artifactId, body, "share-owner")).toEqual(grant);
      const query = { digest: shared.digest, encodedBytes: shared.encodedBytes, mediaType: "text/plain" };
      const read = await a.console.tickets.readShared(OWNER, OTHER_PROJECT, a.artifactId, query);
      expect(new TextDecoder().decode(read.bytes)).toBe("<script>alert('x')</script>");
      // The reader needs current read on the TARGET; the source membership does not carry over.
      await expect(a.console.tickets.readShared(MEMBER, OTHER_PROJECT, a.artifactId, query)).rejects.toMatchObject({ code: "factory_forbidden" });
      // Other bytes of the same run, a changed digest, or another media type stay unreadable.
      await expect(a.console.tickets.readShared(OWNER, OTHER_PROJECT, second.artifactId, { digest: second.digest, encodedBytes: second.encodedBytes, mediaType: "text/plain" })).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
      await expect(a.console.tickets.readShared(OWNER, OTHER_PROJECT, a.artifactId, { ...query, digest: second.digest })).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
      await expect(a.console.tickets.readShared(OWNER, OTHER_PROJECT, a.artifactId, { ...query, mediaType: "application/json" })).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
      // Evidence, attempts, and release authority do not transfer: the source run is not visible from the target.
      await expect(a.console.inspections.inspect(OWNER, { projectId: OTHER_PROJECT, runId: a.runId })).rejects.toMatchObject({ code: "factory_run_not_found" });
      const revoked = await a.console.tickets.unshare(OWNER, key(), a.artifactId, OTHER_PROJECT, "unshare-owner");
      expect(revoked.revoked).toBe(true);
      await expect(a.console.tickets.readShared(OWNER, OTHER_PROJECT, a.artifactId, query)).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
    });
  });

  describe("tenant purge request", () => {
    test("only a human tenant administrator may ask, and open work refuses it with named preconditions", async () => {
      await expect(a.console.purge.preview(MEMBER, a.tenantId)).rejects.toMatchObject({ code: "factory_forbidden" });
      await expect(a.console.purge.preview({ ...OWNER, authentication: "api-key" }, a.tenantId)).rejects.toMatchObject({ code: "factory_human_required" });
      await expect(a.console.purge.preview(OWNER, b.tenantId)).rejects.toMatchObject({ code: "factory_forbidden" });
      const preview = await a.console.purge.preview(OWNER, a.tenantId);
      expect(preview.ready).toBe(false);
      expect(Object.fromEntries(preview.preconditions.map(item => [item.id, item.satisfied]))).toMatchObject({ "live-runs": false, "open-releases": false, "pending-approvals": false });
      expect(preview.auditRowsLost).toBeGreaterThan(0);
    });

    test("a request is recorded once per key, replays exactly, and a changed body conflicts", async () => {
      const body = { reason: "tenant closing", confirmTenantId: a.tenantId };
      await expect(a.console.purge.request(OWNER, a.tenantId, { ...body, confirmTenantId: "wrong" }, "purge-key-0")).rejects.toMatchObject({ code: "factory_purge_confirmation" });
      const [first, concurrent] = await Promise.all([
        a.console.purge.request(OWNER, a.tenantId, body, "purge-key-1"),
        a.console.purge.request(OWNER, a.tenantId, body, "purge-key-1"),
      ]);
      expect(concurrent).toEqual(first);
      expect(first.state).toBe("refused");
      expect(await a.console.purge.request(OWNER, a.tenantId, body, "purge-key-1")).toEqual(first);
      await expect(a.console.purge.request(OWNER, a.tenantId, { ...body, reason: "different" }, "purge-key-1")).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(a.console.purge.request(OWNER, a.tenantId, body, "")).rejects.toMatchObject({ code: "invalid_idempotency_key" });
      const audit = rows<{ n: string | number }>(await a.fixture.db.execute(sql`SELECT COUNT(*) AS n FROM audit_log WHERE action='factory.tenant.purge.requested' AND target=${a.tenantId}`));
      expect(Number(audit[0]!.n)).toBe(1);
      // Authority is rechecked before a replay is served.
      await expect(a.console.purge.request(MEMBER, a.tenantId, body, "purge-key-1")).rejects.toMatchObject({ code: "factory_forbidden" });
    });
  });

  describe("runner packages", () => {
    test("install, preview, publish, quarantine, and revoke run through W02's fence with exact revisions", async () => {
      const blobs = a.fixture.blobs;
      const sourceDigest = await blobs.put(new TextEncoder().encode(canonicalJson({ "extension.ts": "export {};" })));
      const current = factoryPackageTestRelease(sourceDigest, digestObject({ "extension.ts": "export {};", ".runner/recipe.json": "{}" }));
      await new DatabaseLifecycleRepository(a.fixture.db).create({ installation: { id: current.installationId, ownerId: OWNER.id, scope: `project:${PROJECT}`, generation: 1, activeReleaseId: current.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 }, workspaces: {}, revisions: {}, operations: {}, releases: { [current.id]: current }, approvals: {} });
      await a.application.grants.set(OWNER, { projectId: PROJECT, principal: OWNER, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
      const install = { reference: packageReference, installationId: current.installationId, releaseId: current.id };
      await expect(a.console.packages.install(MEMBER, PROJECT, install, "install-member")).rejects.toMatchObject({ code: "factory_forbidden" });
      await expect(a.console.packages.install({ ...OWNER, authentication: "api-key" }, PROJECT, install, "install-key")).rejects.toMatchObject({ code: "factory_package_human_required" });
      const bound = await a.console.packages.install(OWNER, PROJECT, install, "install-owner");
      expect(bound).toMatchObject({ reference: packageReference, revision: 0, installationId: current.installationId, releaseId: current.id });
      expect(bound.state).toBeUndefined();
      expect(await a.console.packages.install(OWNER, PROJECT, install, "install-owner")).toEqual(bound);
      expect((await a.console.packages.list(OWNER, PROJECT)).items).toEqual([bound]);
      expect((await a.console.packages.list(OWNER, PROJECT, { search: "no-such-package" })).items).toEqual([]);
      const refused = await a.console.packages.impact(OWNER, PROJECT, bound.referenceId, "quarantine");
      expect(refused).toMatchObject({ allowed: false, currentRevision: 0, refusal: "The untrusted package cannot take the quarantine transition.", truncated: false });
      // The console factory's lock holds a DIFFERENT package with the same placeholder digest; it is not affected.
      expect(refused.runs).toEqual([]);
      const packaged: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: "console-packaged", inputPorts: {}, outputPorts: {}, graph: { nodes: [], outputs: {} },
        packages: [...referenceCodeV1.packages, { name: packageReference.package, version: packageReference.version, digest: packageReference.digest }] };
      await a.application.definitions.save(OWNER, { projectId: PROJECT, factoryId: packaged.id }, 0, "packaged-save", packaged);
      const packagedVersion = await a.application.definitions.publish(OWNER, { projectId: PROJECT, factoryId: packaged.id }, 1, "packaged-publish");
      const packagedRun = (await a.application.runs.start(OWNER, { projectId: PROJECT, factoryId: packaged.id }, { factoryVersion: packagedVersion.version, definitionDigest: packagedVersion.definitionDigest, grantRevision: 1, parameters: {} }, 0, "packaged-start")).run.runId;
      expect((await a.console.packages.impact(OWNER, PROJECT, bound.referenceId, "quarantine")).runs).toEqual([{ runId: packagedRun, factoryId: "console-packaged", status: "queued", liveAttempts: 0 }]);
      const active = await a.console.packages.transition(OWNER, PROJECT, bound.referenceId, "publish", 0, "trust-publish");
      expect(active).toMatchObject({ revision: 1, state: "active" });
      await expect(a.console.packages.transition(OWNER, PROJECT, bound.referenceId, "quarantine", 0, "trust-zero")).rejects.toMatchObject({ code: "factory_package_trust_invalid" });
      await expect(a.console.packages.transition(OWNER, PROJECT, bound.referenceId, "quarantine", 5, "trust-stale")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
      await expect(a.console.packages.transition(MEMBER, PROJECT, bound.referenceId, "quarantine", 1, "trust-member")).rejects.toMatchObject({ code: "factory_forbidden" });
      const preview = await a.console.packages.impact(OWNER, PROJECT, bound.referenceId, "quarantine");
      expect(preview).toMatchObject({ transition: "quarantine", allowed: true, currentRevision: 1 });
      expect(preview.refusal).toBeUndefined();
      const quarantined = await a.console.packages.transition(OWNER, PROJECT, bound.referenceId, "quarantine", 1, "trust-quarantine");
      expect(quarantined).toMatchObject({ revision: 2, state: "quarantined" });
      const revoked = await a.console.packages.transition(OWNER, PROJECT, bound.referenceId, "revoke", 2, "trust-revoke");
      expect(revoked).toMatchObject({ revision: 3, state: "revoked" });
      expect(await a.console.packages.impact(OWNER, PROJECT, bound.referenceId, "publish")).toMatchObject({ allowed: false, refusal: expect.stringContaining("revoked") });
      await expect(a.console.packages.transition(OWNER, PROJECT, bound.referenceId, "publish", 3, "trust-reopen")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
      const audit = rows<{ action: string }>(await a.fixture.db.execute(sql`SELECT action FROM audit_log WHERE action LIKE 'factory.package.trust.%' ORDER BY created_at`));
      expect(audit.map(row => row.action)).toEqual(["factory.package.trust.published", "factory.package.trust.quarantined", "factory.package.trust.revoked"]);
      // The other installation holds the same identifiers and none of this.
      expect((await b.console.packages.list(OWNER, PROJECT)).items).toEqual([]);
    });

    test("an unbound reference is not found, the list is scoped, and a transition needs a human administrator", async () => {
      await expect(a.console.packages.list(OUTSIDER, PROJECT)).rejects.toMatchObject({ code: "factory_forbidden" });
      await expect(a.console.packages.read(OWNER, PROJECT, "0".repeat(64))).rejects.toMatchObject({ code: "factory_package_not_found" });
      await expect(a.console.packages.read(OWNER, PROJECT, "not-hex")).rejects.toMatchObject({ code: "factory_package_not_found" });
      await expect(a.console.packages.list(OWNER, PROJECT, { cursor: "bad" })).rejects.toMatchObject({ code: "factory_package_not_found" });
      await expect(a.console.packages.list(OWNER, PROJECT, { limit: 0 })).rejects.toMatchObject({ code: "factory_page_invalid" });
    });
  });
}
