import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { assertBunSqlPipeliningOff } from "../../../src/db/bun-sql-pipelining";
import { canonicalJson } from "@ezcorp/extension-contract";
import { drizzle } from "drizzle-orm/bun-sql";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import { migrate } from "../../../src/db/migrate";
import * as schema from "../../../src/db/schema";
import { __test } from "../../../src/db/connection";
import type { TransactionalDb } from "../../../src/db/migrations/types";
import { factoryStopHostKeyMap } from "../../../src/factory/task-stops";
import { signFactoryPhysicalStopReceipt, type FactoryPhysicalStopReceipt, type FactoryUnsignedPhysicalStopReceipt } from "../../../src/factory/runner/attempt-wire";
import type { FactoryHostStopCommand } from "../../../src/factory/runner/host-stop-service";
import { factoryLaunchPackage } from "../../../src/__tests__/helpers/factory-attempt-launch-fixture";
import { FactoryDatabaseAttemptLaunchStore } from "../../../src/factory/runner/attempt-runtime";

/**
 * Real PostgreSQL databases a restore test copies byte for byte.
 *
 * A backup here is `CREATE DATABASE ... TEMPLATE`, taken the moment after a
 * sealed barrier with every connection to the source closed, so the copy holds
 * exactly the committed state at the barrier — what a point-in-time recovery to
 * the barrier's WAL position produces. The WAL proof (`w15/bin/wal-pitr-proof.ts`)
 * shows that equivalence with a real archive and a real recovery.
 */

function adminUrl(): string {
  const url = process.env.FACTORY_TEST_POSTGRES_URL;
  if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL restore proofs.");
  return url;
}

function urlFor(name: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export interface FactoryOpenDatabase {
  readonly name: string;
  readonly client: SQL;
  readonly db: TransactionalDb;
  close(): Promise<void>;
}

export class FactoryRecoveryDatabases {
  // W12e: fail by name on an affected Bun without the flag at process start, before the first client opens.
  private readonly admin = (assertBunSqlPipeliningOff(), new SQL(adminUrl(), { max: 1 }));
  private readonly created: string[] = [];

  private fresh(label: string): string {
    const name = `factory_w15_${label}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.created.push(name);
    return name;
  }

  open(name: string, max = 6): FactoryOpenDatabase {
    const client = new SQL(urlFor(name), { max });
    return { name, client, db: drizzle(client, { schema }) as unknown as TransactionalDb, close: () => client.close() };
  }

  /** A newly created database with every migration applied. */
  async migrated(label: string): Promise<FactoryOpenDatabase> {
    const name = this.fresh(label);
    await this.admin.unsafe(`CREATE DATABASE "${name}"`);
    const opened = this.open(name);
    __test.setState(opened.db as never, null);
    await __test.applyBunSqlJsonbFix();
    await __test.withPostgresMigrateLock(migrationDb => migrate(migrationDb));
    return opened;
  }

  /** A byte-for-byte copy. The source must have no open connections. */
  async copy(source: string, label: string): Promise<string> {
    const name = this.fresh(label);
    await this.admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${source}"`);
    return name;
  }

  /** An empty pool ledger database. */
  async empty(label: string): Promise<FactoryOpenDatabase> {
    const name = this.fresh(label);
    await this.admin.unsafe(`CREATE DATABASE "${name}"`);
    return this.open(name);
  }

  /** Drops exactly the databases this helper created. */
  async close(): Promise<void> {
    for (const name of this.created.reverse()) await this.admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await this.admin.close();
  }
}

/**
 * The original supervisor's stop, with a real RSA host key: it signs exactly
 * the facts it was asked to stop, the way the host stop service does. A test
 * can make it refuse, or count what it stopped.
 */
export class FactorySigningSupervisor {
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly stopped: FactoryHostStopCommand[] = [];
  refuse = false;
  constructor(readonly hostId: string, readonly hostKeyId = "host-key-1") {}

  get hostKeys() { return factoryStopHostKeyMap([{ hostId: this.hostId, hostKeyId: this.hostKeyId, publicKey: this.keys.publicKey.export({ type: "spki", format: "pem" }) }]); }

  async stop(command: FactoryHostStopCommand): Promise<FactoryPhysicalStopReceipt> {
    if (this.refuse) throw new Error("host supervisor unreachable");
    this.stopped.push(command);
    const unsigned: FactoryUnsignedPhysicalStopReceipt = { schemaVersion: "factory.physical-stop.v1", attemptId: command.attemptId, reservationId: command.reservationId, workerId: command.workerId, holderGeneration: command.holderGeneration, allocationGeneration: command.allocationGeneration, processGroupAbsent: true, stoppedAtMs: Date.now(), reason: command.reason, hostId: command.hostId };
    const signature = signFactoryPhysicalStopReceipt(unsigned, this.hostKeyId, this.keys.privateKey);
    return { ...unsigned, ...signature, receiptDigest: `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}` };
  }
}

/** Admits and launches one attempt through the real launch store, leaving it `launched` with a live guest. */
export async function launchFactoryAttempt(db: TransactionalDb, authority: FactoryRunnerRequest["authority"], lease: { reservationId: string; allocationGeneration: number; holderGeneration: number; hostId: string }): Promise<FactoryRunnerRequest> {
  const request: FactoryRunnerRequest = {
    schemaVersion: "factory.runner.request.v1",
    authority,
    runner: { package: "runner", manifestName: "runner", version: "1", digest: `sha256:${"a".repeat(64)}`, export: "run", model: "recovery-model", configurationDigest: `sha256:${"a".repeat(64)}` },
    input: { kind: "inline", value: { prompt: "recovery" } },
    grants: [], resources: {}, tools: [],
    broker: { audience: "gateway", attemptToken: "ephemeral-token" },
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${authority.attemptId},${authority.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${authority.attemptNumber},${authority.grantRevision},${authority.reservationGeneration},${authority.executionEpoch},${authority.cancellationEpoch},${new Date(authority.deadlineAtMs)},${factoryRunnerRequestDigest(request)},'{}','admitted')`);
  const store = new FactoryDatabaseAttemptLaunchStore(db);
  await store.prepare(request, { reservationId: lease.reservationId, grantRevision: authority.grantRevision, allocationGeneration: lease.allocationGeneration, holderGeneration: lease.holderGeneration, allocationToken: `token-${lease.reservationId}`, hostId: lease.hostId }, factoryLaunchPackage(request));
  await store.claimStart(authority.attemptId);
  await store.state(authority.attemptId, "launched");
  return request;
}
