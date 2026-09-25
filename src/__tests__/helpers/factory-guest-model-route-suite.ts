import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { validateFactoryRunnerResult, type FactoryModelPin, type FactoryRunnerRequest, type FactoryRunnerResult, type JsonValue } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { MigrateDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import { digestObject, FileBlobStore } from "../../extensions/v4/blobs";
import { FactoryWorkspaceCheckpoints } from "../../factory/artifact-materials";
import { FactoryArtifacts } from "../../factory/artifacts";
import { signFactoryAttemptToken } from "../../factory/attempt-token";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FACTORY_PROVIDER_NOT_CONFIGURED, factoryUnpinnedModelProvider } from "../../factory/guest-broker-composition";
import type { FactoryBroker, FactoryBrokerRequest } from "../../runtime/factory-execution";
import { FACTORY_GUEST_BROKER_PATH, FACTORY_GUEST_BROKER_SCOPE } from "../../factory/runner/guest-broker-contract";
import { createFactoryGuestBrokerRouteHandler } from "../../factory/runner/guest-broker-service";
import { createFactoryGuestMaterialFrameBroker, createFactoryGuestMaterialServices } from "../../factory/runner/guest-material-broker";
import type { FactoryOneHopProvider } from "../../factory/runner/guest-model-broker";
import { createFactoryGuestModelFrameBroker } from "../../factory/runner/guest-model-route";
import { createFactoryOneHopProvider } from "../../factory/runner/provider-one-hop";
import { signedServiceToken } from "./factory-certificates";
import { combine, combineSummary, infer, prepare } from "../../../scripts/factory-graph-proof/guest/graph-guest";

/**
 * A sandboxed guest's model call, answered by the product route, on a real store.
 *
 * The guest is the W19a proof guest itself, imported from the harness, and
 * every call it makes goes through the real guest-broker route handler — host
 * identity, host bearer token, attempt token, lease — into the real model
 * broker, journal, W04 checkpoint writer, and material service. Only the
 * provider stream is a double, and it records what it was asked.
 *
 * The central claim is the one the real-server proof depends on: a guest that
 * called its model returns a COMPLETED result whose operations mirror the
 * journal exactly, so `verifyRunnerResultInTransaction` accepts it.
 */

const TENANT = "graph-tenant";
const INSTALLATION = "graph-installation";
const SECRET = "graph-attempt-token-secret";
const HOST_IDENTITY = "graph-host-peer";
const HOST = "graph-host";
const ISSUER = "graph-issuer";
const AUDIENCE = "factory-guest-broker";
const DIGEST = `sha256:${"a".repeat(64)}`;

const configuration = { temperature: 0, seed: 7, reasoningEffort: "none" };
const policy = { tools: false };
const pin: FactoryModelPin = {
  provider: "ollama", model: "qwen3:1.7b",
  configuration, configurationDigest: `sha256:${digestObject(configuration)}`,
  policy, policyDigest: `sha256:${digestObject(policy)}`,
};

export interface FactoryGuestModelRouteFixture {
  db: MigrateDb & TransactionalDb;
  close(): Promise<void>;
}

interface Attempt {
  readonly request: FactoryRunnerRequest;
  readonly authority: FactoryAttemptAuthority;
  readonly token: string;
}

/** A provider stream that answers one message and records what each call asked for. */
function streamDouble(answer: (request: FactoryBrokerRequest) => Promise<Partial<AssistantMessage>> | Partial<AssistantMessage>) {
  const seen: FactoryBrokerRequest[] = [];
  const broker: FactoryBroker = {
    async stream(request) {
      seen.push(request);
      const message = {
        role: "assistant", content: [], api: "openai-completions", provider: pin.provider, model: pin.model,
        usage: { input: 11, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 0,
        ...await answer(request),
      } as AssistantMessage;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.end(message);
      return stream;
    },
  };
  return { broker, seen };
}

function providerOver(broker: FactoryBroker): FactoryOneHopProvider {
  let clock = 1_000;
  return createFactoryOneHopProvider({ broker, resolveModel: (asked) => ({ id: asked.model, provider: asked.provider, api: "openai-completions" }) as Model<Api>, now: () => { clock += 3; return clock; } });
}

function text(message: string): Partial<AssistantMessage> {
  return { content: [{ type: "text", text: message }] };
}

export function factoryGuestModelRouteConformance(createFixture: () => Promise<FactoryGuestModelRouteFixture>): void {
  let fixture: FactoryGuestModelRouteFixture;
  let root: string;
  let journal: FactoryExecutionJournal;
  let stores: { database: TransactionalDb; artifacts: FactoryArtifacts; blobs: FileBlobStore; journal: FactoryExecutionJournal };
  const projectId = `graph-project-${randomUUID()}`;
  const runId = `graph-run-${randomUUID()}`;
  const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const hostToken = signedServiceToken(hostKeys.privateKey, { sub: HOST_IDENTITY, iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1_000) + 3_600, scope: [FACTORY_GUEST_BROKER_SCOPE] });

  beforeAll(async () => {
    fixture = await createFixture();
    root = await mkdtemp(join(tmpdir(), "factory-guest-model-route-"));
    const db = fixture.db;
    await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Graph', ${`/tmp/${projectId}`})`);
    await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 1) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${DIGEST}, 'test', 1, 'request', '{}')`);
    journal = new FactoryExecutionJournal(db, async () => {});
    const blobs = new FileBlobStore(join(root, "blobs"));
    stores = { database: db, artifacts: new FactoryArtifacts(db, blobs, TENANT), blobs, journal };
  });

  afterAll(async () => {
    await fixture?.close();
    await rm(root, { recursive: true, force: true });
  });

  let admitted = 0;
  /** One admitted attempt, on its own node so its rows are its own. */
  async function admit(options: { readonly model?: FactoryModelPin; readonly input?: JsonValue; readonly exportName?: string } = {}): Promise<Attempt> {
    admitted += 1;
    const model = "model" in options ? options.model : pin;
    const request: FactoryRunnerRequest = {
      schemaVersion: "factory.runner.request.v1",
      authority: {
        attemptId: `graph-attempt-${admitted}`, tenantId: TENANT, projectId, runId, nodeInstanceId: `graph-node-${admitted}`, candidateGeneration: 0, attemptNumber: 1,
        grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: Date.now() + 600_000, nextOperationIndex: 0,
      },
      runner: { package: "@ezcorp/w19a-graph-guest", manifestName: "w19a-graph-guest", version: "1.0.0", digest: DIGEST, export: options.exportName ?? "infer", ...(model === undefined ? {} : { model: model.model, configurationDigest: model.configurationDigest }) },
      input: { kind: "inline", value: options.input ?? { text: "Name the primary colours of light." } },
      grants: [], resources: {}, ...(model === undefined ? {} : { model }), tools: [],
      broker: { attemptToken: "durable", audience: INSTALLATION },
    };
    const { deadlineAtMs, nextOperationIndex: _next, ...fields } = request.authority;
    const authority: FactoryAttemptAuthority = { ...fields, requestDigest: factoryRunnerRequestDigest(request), deadlineAt: new Date(deadlineAtMs) };
    await journal.admit({ ...authority, request });
    const token = await signFactoryAttemptToken(authority, SECRET, INSTALLATION);
    return { request: { ...request, broker: { ...request.broker, attemptToken: token } }, authority, token };
  }

  /** The real route handler, as a host reaches it, with the model half over `provider`. */
  function route(provider: () => Promise<FactoryOneHopProvider>, lease: () => string | undefined = () => HOST, routeOptions: { readonly installationPin?: { provider: string; model: string } | null; readonly journal?: FactoryExecutionJournal } = {}) {
    // The installation's own pin by default, as the composition passes it; `null` declares none.
    const installationPin = routeOptions.installationPin === undefined ? { provider: pin.provider, model: pin.model } : routeOptions.installationPin;
    const handle = createFactoryGuestBrokerRouteHandler({
      hosts: { [HOST_IDENTITY]: HOST },
      tokens: async () => ({ issuer: ISSUER, audience: AUDIENCE, publicKeys: { test: hostKeys.publicKey.export({ type: "spki", format: "pem" }).toString() } }),
      leaseHost: async () => lease(),
      broker: createFactoryGuestMaterialFrameBroker({ services: createFactoryGuestMaterialServices(stores) }),
      model: createFactoryGuestModelFrameBroker({ journal: routeOptions.journal ?? journal, workspace: new FactoryWorkspaceCheckpoints(stores), provider, ...(installationPin === null ? {} : { installationPin }) }),
      jwtSecret: SECRET,
      installationId: INSTALLATION,
    });
    /** The guest's `factory.broker`, carried by a host that holds the lease. */
    return (attempt: Attempt, token = attempt.token) => async (payload: JsonValue): Promise<unknown> => {
      const response = await handle({
        peerIdentity: HOST_IDENTITY, method: "POST", path: FACTORY_GUEST_BROKER_PATH,
        headers: { authorization: `Bearer ${hostToken}` },
        body: Buffer.from(JSON.stringify({ attemptToken: token, payload })),
      });
      const body = JSON.parse(new TextDecoder().decode(response.body)) as unknown;
      if (response.status !== 200) throw new Error(`route answered ${response.status}: ${JSON.stringify(body)}`);
      return body;
    };
  }

  async function verifies(attempt: Attempt, result: Record<string, JsonValue>): Promise<void> {
    expect(validateFactoryRunnerResult(result).ok).toBe(true);
    await fixture.db.transaction(transaction => journal.verifyRunnerResultInTransaction(transaction, attempt.authority, result as unknown as FactoryRunnerResult));
  }

  /** The candidate output a result names, read back through the product's own artifact store. */
  async function stagedOutput(result: Record<string, JsonValue>): Promise<unknown> {
    const output = result.output as { artifactId: string; digest: string; encodedBytes: number };
    const loaded = await stores.artifacts.load({ tenantId: TENANT, projectId, logicalRunId: runId }, { objectId: output.artifactId, digest: output.digest, encodedBytes: output.encodedBytes }, ["candidate_output"]);
    return JSON.parse(new TextDecoder().decode(loaded.content)) as unknown;
  }

  async function operationRows(attempt: Attempt) {
    // Copied into plain objects: a real PostgreSQL driver's rows are not, and
    // an object matcher compares prototypes as well as fields.
    return releaseRows<{ operation_id: string; state: string; kind: string; provider_receipt_digest: string | null; result_json: unknown }>(await fixture.db.execute(sql`SELECT operation_id, state, kind, provider_receipt_digest, result_json FROM factory_execution_operations WHERE attempt_id=${attempt.authority.attemptId} ORDER BY operation_index`)).map(row => ({ ...row }));
  }

  test("a pinned guest completes an attempt that called its model, and its result mirrors the journal exactly", async () => {
    const attempt = await admit();
    const provider = streamDouble(() => text("Red, green, and blue."));
    const result = await infer(attempt.request, route(async () => providerOver(provider.broker))(attempt));

    expect(result).toMatchObject({ status: "completed", journalCursor: 0 });
    await verifies(attempt, result);
    const rows = await operationRows(attempt);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation_id: `${runId}:${attempt.authority.nodeInstanceId}:0:0`, state: "completed", kind: "model" });
    // The staged output is the model's own answer and counters, byte for byte.
    const staged = await stagedOutput(result);
    expect(staged).toEqual({ answer: "Red, green, and blue.", usage: { inputTokens: 11, outputTokens: 5 } });
    expect(provider.seen).toHaveLength(1);
  });

  test("the pin's temperature, seed and reasoning effort reach the provider request, and nothing else is added", async () => {
    const attempt = await admit();
    const provider = streamDouble(() => text("ok"));
    await infer(attempt.request, route(async () => providerOver(provider.broker))(attempt));
    expect(provider.seen[0]?.options).toEqual({ temperature: 0, samplingParams: { seed: 7, reasoning_effort: "none" }, maxTokens: 64 });
    expect(provider.seen[0]?.model).toMatchObject({ provider: "ollama", id: "qwen3:1.7b" });
    // The request the provider saw is the one the guest sent, turn for turn.
    expect(provider.seen[0]?.context.systemPrompt).toBe("Answer in one short sentence.");
  });

  test("a provider error is journaled as a failed operation, and the guest's failed result mirrors it", async () => {
    const attempt = await admit();
    const provider = streamDouble(() => ({ stopReason: "error", errorMessage: "model 'qwen3:missing' not found" }));
    const result = await infer(attempt.request, route(async () => providerOver(provider.broker))(attempt));
    expect(result).toMatchObject({ status: "failed", error: { code: "provider_unavailable", retryable: false } });
    expect(String((result.error as { message: string }).message)).toContain("model 'qwen3:missing' not found");
    // The failed row carries no usage, so the result cannot claim a measured total.
    expect("usage" in result).toBe(false);
    await verifies(attempt, result);
    const rows = await operationRows(attempt);
    expect(rows).toMatchObject([{ state: "failed", kind: "model", provider_receipt_digest: null }]);
  });

  test("an installation that pins no provider refuses by name and still journals the failed call", async () => {
    const attempt = await admit();
    const result = await infer(attempt.request, route(factoryUnpinnedModelProvider, () => HOST, { installationPin: null })(attempt));
    expect(result).toMatchObject({ status: "failed", error: { code: "provider_unavailable" } });
    expect(String((result.error as { message: string }).message)).toStartWith(FACTORY_PROVIDER_NOT_CONFIGURED);
    await verifies(attempt, result);
    expect(await operationRows(attempt)).toMatchObject([{ state: "failed" }]);
  });

  test("a configuration key this installation cannot honour is refused by name before any claim", async () => {
    const odd = { temperature: 0, topK: 4 };
    const oddPin: FactoryModelPin = { ...pin, configuration: odd, configurationDigest: `sha256:${digestObject(odd)}` };
    const attempt = await admit({ model: oddPin });
    const provider = streamDouble(() => text("never"));
    const result = await infer(attempt.request, route(async () => providerOver(provider.broker))(attempt));
    expect(result).toMatchObject({ status: "failed", operations: [], error: { code: "invalid_request", message: "factory_model_configuration_unsupported: topK" } });
    expect(provider.seen).toHaveLength(0);
    // Refused before the claim, so no failed row is left behind.
    expect(await operationRows(attempt)).toHaveLength(0);
    await verifies(attempt, result);
  });

  test("an attempt pinned to a model the installation does not serve is refused before any claim or provider call", async () => {
    // Admitted under this pin; the installation now serves another model, as
    // after a restart that changed `modelProvider`.
    const attempt = await admit();
    const provider = streamDouble(() => text("never"));
    const result = await infer(attempt.request, route(async () => providerOver(provider.broker), () => HOST, { installationPin: { provider: "ollama", model: "qwen3:8b" } })(attempt));
    expect(result).toMatchObject({ status: "failed", operations: [], error: { code: "model_pin_mismatch" } });
    expect(String((result.error as { message: string }).message)).toStartWith("factory_model_pin_not_installed");
    expect(provider.seen).toHaveLength(0);
    expect(await operationRows(attempt)).toHaveLength(0);
    await verifies(attempt, result);
  });

  test("a store failure is transient and retryable, and the guest never sees the store's own text", async () => {
    const attempt = await admit();
    const provider = streamDouble(() => text("never"));
    const secretText = "connect ECONNRESET 10.0.0.7:5432 while reading factory_executions for tenant graph-tenant";
    // A store-side failure may carry a factory code of its own (a key error
    // raised inside the store); it is still the store failing, not the attempt.
    const storeError = Object.assign(new Error(secretText), { code: "factory_key_unavailable" });
    const failing = (method: "request" | "prepare") => new Proxy(journal, {
      get(target, property, receiver) {
        if (property === method) return async () => { throw storeError; };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const ask = { schemaVersion: "factory.guest-model-request.v1", operationId: `${runId}:${attempt.authority.nodeInstanceId}:0:0`, operationIndex: 0, model: pin, messages: [{ role: "user", text: "x" }], maxOutputTokens: 8 } as unknown as JsonValue;
    for (const method of ["request", "prepare"] as const) {
      const answer = await route(async () => providerOver(provider.broker), () => HOST, { journal: failing(method) })(attempt)(ask) as { status: string; refusal: { code: string; message: string } };
      expect(answer).toMatchObject({ status: "refused", refusal: { code: "operation_busy" } });
      expect(answer.refusal.message).toStartWith("factory_journal_unavailable");
      expect(JSON.stringify(answer)).not.toContain("ECONNRESET");
      expect(JSON.stringify(answer)).not.toContain("factory_key_unavailable");
    }
    expect(provider.seen).toHaveLength(0);
    expect(await operationRows(attempt)).toHaveLength(0);
  });

  test("an attempt admitted with no pin may call no model: refused before any claim, and the failed result verifies", async () => {
    const attempt = await admit({ model: undefined });
    const provider = streamDouble(() => text("never"));
    const result = await infer(attempt.request, route(async () => providerOver(provider.broker))(attempt));
    // Measured zero, the sum over no operations: an unmeasured result would
    // leave an unknown budget hold nothing can clear, and the run could not end.
    expect(result).toMatchObject({ status: "failed", journalCursor: -1, operations: [], error: { code: "model_pin_mismatch" }, usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" } });
    expect(provider.seen).toHaveLength(0);
    expect(await operationRows(attempt)).toHaveLength(0);
    await verifies(attempt, result);
  });

  test("a guest asking for another model than its pin is refused model_pin_mismatch with nothing claimed", async () => {
    const attempt = await admit();
    const call = route(async () => providerOver(streamDouble(() => text("never")).broker))(attempt);
    const answer = await call({ schemaVersion: "factory.guest-model-request.v1", operationId: `${runId}:${attempt.authority.nodeInstanceId}:0:0`, operationIndex: 0, model: { ...pin, model: "qwen3:8b" }, messages: [{ role: "user", text: "hi" }], maxOutputTokens: 8 } as unknown as JsonValue);
    expect(answer).toMatchObject({ status: "refused", refusal: { code: "model_pin_mismatch" } });
    expect(await operationRows(attempt)).toHaveLength(0);
  });

  test("two concurrent calls for one operation: one provider call, one answer, one operation_busy", async () => {
    const attempt = await admit();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reached: () => void = () => {};
    const inFlight = new Promise<void>(resolve => { reached = resolve; });
    const provider = streamDouble(async () => { reached(); await gate; return text("once"); });
    const call = route(async () => providerOver(provider.broker))(attempt);
    const ask = { schemaVersion: "factory.guest-model-request.v1", operationId: `${runId}:${attempt.authority.nodeInstanceId}:0:0`, operationIndex: 0, model: pin, messages: [{ role: "user", text: "once" }], maxOutputTokens: 8 } as unknown as JsonValue;
    const first = call(ask);
    await inFlight;
    const second = await call(ask);
    release();
    expect(second).toMatchObject({ status: "refused", refusal: { code: "operation_busy" } });
    expect(await first).toMatchObject({ status: "completed", text: "once" });
    expect(provider.seen).toHaveLength(1);
  });

  test("a call repeated after a lost answer is operation_settled, from this broker and from a restarted one", async () => {
    const attempt = await admit();
    const provider = streamDouble(() => text("settled"));
    const ask = { schemaVersion: "factory.guest-model-request.v1", operationId: `${runId}:${attempt.authority.nodeInstanceId}:0:0`, operationIndex: 0, model: pin, messages: [{ role: "user", text: "lost" }], maxOutputTokens: 8 } as unknown as JsonValue;
    expect(await route(async () => providerOver(provider.broker))(attempt)(ask)).toMatchObject({ status: "completed" });
    expect(await route(async () => providerOver(provider.broker))(attempt)(ask)).toMatchObject({ status: "refused", refusal: { code: "operation_settled" } });
    // A new route and broker, as after a product restart: the durable row decides.
    expect(await route(async () => providerOver(provider.broker))(attempt)(ask)).toMatchObject({ status: "refused", refusal: { code: "operation_settled" } });
    expect(provider.seen).toHaveLength(1);
    expect(await operationRows(attempt)).toHaveLength(1);
  });

  test("an operation id reused for different content is refused by the journal before any provider call", async () => {
    const attempt = await admit();
    const provider = streamDouble(() => text("first"));
    const call = route(async () => providerOver(provider.broker))(attempt);
    const ask = (words: string) => ({ schemaVersion: "factory.guest-model-request.v1", operationId: `${runId}:${attempt.authority.nodeInstanceId}:0:0`, operationIndex: 0, model: pin, messages: [{ role: "user", text: words }], maxOutputTokens: 8 }) as unknown as JsonValue;
    expect(await call(ask("the first question"))).toMatchObject({ status: "completed" });
    expect(await call(ask("a different question"))).toMatchObject({ status: "refused", refusal: { code: "invalid_request", message: "factory_operation_conflict" } });
    expect(provider.seen).toHaveLength(1);
    expect(await operationRows(attempt)).toMatchObject([{ state: "completed" }]);
  });

  test("an unknown attempt, another generation, another project and a cancelled attempt are refused by name with nothing claimed", async () => {
    const live = await admit();
    const provider = streamDouble(() => text("never"));
    const call = route(async () => providerOver(provider.broker));
    const ask = (attempt: FactoryAttemptAuthority) => ({ schemaVersion: "factory.guest-model-request.v1", operationId: `${runId}:${attempt.nodeInstanceId}:0:0`, operationIndex: 0, model: pin, messages: [{ role: "user", text: "x" }], maxOutputTokens: 8 }) as unknown as JsonValue;
    const forged = async (authority: FactoryAttemptAuthority) => call({ ...live, authority }, await signFactoryAttemptToken(authority, SECRET, INSTALLATION))(ask(authority));

    // The code alone: the journal's own text never reaches the guest.
    expect(await forged({ ...live.authority, attemptId: "graph-attempt-never" })).toMatchObject({ status: "refused", refusal: { code: "invalid_request", message: "factory_attempt_unknown" } });
    expect(await forged({ ...live.authority, candidateGeneration: 1 })).toMatchObject({ status: "refused", refusal: { code: "invalid_request", message: "factory_attempt_not_live" } });
    expect(await forged({ ...live.authority, projectId: "graph-project-other" })).toMatchObject({ status: "refused", refusal: { code: "invalid_request", message: "factory_attempt_unknown" } });
    expect(await journal.cancel(live.authority)).toBe(true);
    expect(await call(live)(ask(live.authority))).toMatchObject({ status: "refused", refusal: { code: "invalid_request", message: "factory_attempt_not_live" } });
    expect(provider.seen).toHaveLength(0);
    expect(await operationRows(live)).toHaveLength(0);
  });

  test("a host that does not hold the attempt's lease never reaches the model broker", async () => {
    const attempt = await admit();
    const provider = streamDouble(() => text("never"));
    const call = route(async () => providerOver(provider.broker), () => "another-host")(attempt);
    await expect(call({ schemaVersion: "factory.guest-model-request.v1" } as unknown as JsonValue)).rejects.toThrow("route answered 403");
    expect(provider.seen).toHaveLength(0);
  });

  test("a checkpoint recovery naming other bytes is refused, so a guest cannot borrow a checkpoint", async () => {
    const attempt = await admit();
    const call = route(async () => providerOver(streamDouble(() => text("ours")).broker))(attempt);
    const result = await infer(attempt.request, call);
    const identity = { operationId: `${runId}:${attempt.authority.nodeInstanceId}:0:0`, operationIndex: 0, objectName: "workspace/operation-0.json", version: 1 };
    const checkpoint = result.workspaceCheckpoint as { digest: string; encodedBytes: number };
    // Another plan for the same sealed name, and a seal over other bytes.
    expect(await call({ schemaVersion: "factory.guest-material-begin.v1", ...identity, mediaType: "application/json", totalBytes: checkpoint.encodedBytes + 1, chunkCount: 1 } as unknown as JsonValue)).toMatchObject({ status: "refused", refusal: { code: "conflict" } });
    expect(await call({ schemaVersion: "factory.guest-material-seal.v1", ...identity, digest: `sha256:${"f".repeat(64)}` } as unknown as JsonValue)).toMatchObject({ status: "refused", refusal: { code: "conflict" } });
    // The recovered handle is still the one the journal holds.
    await verifies(attempt, result);
  });

  test("prepare and combine complete with no operation, and combine's summary is computed from its two inputs", async () => {
    const prepared = await admit({ model: undefined, exportName: "prepare", input: { topic: "  primary   colours of light " } });
    const provider = streamDouble(() => text("never"));
    const first = await prepare(prepared.request, route(async () => providerOver(provider.broker))(prepared));
    expect(first).toMatchObject({ status: "completed", journalCursor: -1, operations: [] });
    await verifies(prepared, first);
    const preparedOutput = await stagedOutput(first);
    expect(preparedOutput).toEqual({ text: "primary colours of light", count: 4 });

    const combined = await admit({ model: undefined, exportName: "combine", input: { count: 4, answer: "Red, green, and blue." } });
    const last = await combine(combined.request, route(async () => providerOver(provider.broker))(combined));
    await verifies(combined, last);
    const summary = await stagedOutput(last);
    expect(summary).toEqual({ summary: combineSummary(4, "Red, green, and blue.") });
    expect(combineSummary(1, "x")).toBe("1 word in; the model said: x");
    expect(provider.seen).toHaveLength(0);
  });

  test("the guests refuse malformed inputs rather than inventing values", async () => {
    const provider = streamDouble(() => text("never"));
    const broken = await admit({ model: undefined, exportName: "prepare", input: { topic: 4 } });
    await expect(prepare(broken.request, route(async () => providerOver(provider.broker))(broken))).rejects.toThrow("prepare needs a string topic");
    const noText = await admit({ input: { words: "x" } });
    await expect(infer(noText.request, route(async () => providerOver(provider.broker))(noText))).rejects.toThrow("infer needs a string text");
    const noCount = await admit({ model: undefined, exportName: "combine", input: { count: "4", answer: "a" } });
    await expect(combine(noCount.request, route(async () => providerOver(provider.broker))(noCount))).rejects.toThrow("combine needs an integer count");
    const artifactInput = { ...broken.request, input: { kind: "artifact", artifact: { artifactId: "a", digest: DIGEST, encodedBytes: 1 } } } as unknown as FactoryRunnerRequest;
    await expect(prepare(artifactInput, async () => null)).rejects.toThrow("inline object");
    expect(provider.seen).toHaveLength(0);
  });
}
