/**
 * One W19a real-server pass: a fresh installation, the graph, the evidence.
 *
 * Env:
 *   W19A_REPO     the worktree whose built server and sources run
 *   W19A_OUT      where the record is written (`<label>.json`)
 *   W19A_LABEL    the record's name
 *   W19A_MODE     `ollama` (the host's Ollama) or `mock` (the in-process
 *                 prompt-digest fake behind the test surface)
 *   W19A_CONTROL  `none` (the proof), `no-pin` (infer admitted with no model
 *                 pin, plus the compile-time bad-port control), or
 *                 `missing-model` (a registered model Ollama does not have)
 *   FACTORY_TEST_POSTGRES_URL, EZCORP_FACTORY_STORAGE_SECRETS_DIR  exported by run.sh
 *
 * Everything the run does goes through public product HTTP under the session
 * the setup route issues, except the runner package installation, which no
 * product route owns yet and is stated as a harness-supplied deployment fact.
 * The evidence is read afterwards from the product database and, for staged
 * outputs, from the object store through the product's own artifact class.
 */
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SQL } from "bun";
import type { FactoryModelPin, JsonValue } from "@ezcorp/factory-sdk";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import { combineSummary, GRAPH_GUEST_OUTPUT } from "./guest/graph-guest";
import { GRAPH_TOPIC, graphDefinition, graphModelPin, graphReferences, graphRunnerProfiles, modePin, OLLAMA_MISSING_MODEL, type GraphProofMode } from "./graph";
import { buildGraphGuest, installGraphGuest, type GraphGuestBuild } from "./guest-package";
import { checkSharedStores, startStack, TENANT, type Stack } from "./stack";

const REPO = process.env.W19A_REPO!;
const OUT = process.env.W19A_OUT!;
const LABEL = process.env.W19A_LABEL ?? "pass";
const MODE = (process.env.W19A_MODE ?? "mock") as GraphProofMode;
const CONTROL = (process.env.W19A_CONTROL ?? "none") as "none" | "no-pin" | "missing-model";
const BUN = process.execPath;
const OLLAMA_URL = "http://127.0.0.1:11434";

const record: Record<string, unknown> = {
  label: LABEL, mode: MODE, control: CONTROL, startedAt: new Date().toISOString(),
  harnessSuppliedDeploymentFacts: [
    "a TLS-terminating sidecar in front of the Temporal dev server; the orchestrator's own mutual TLS is unrelaxed",
    "the runner package installation (bind, trust, prepare) through the product's own classes, because no product route owns it yet (W02)",
  ],
};
const steps: Array<Record<string, unknown>> = [];
record.steps = steps;
let stack: Stack | undefined;

async function finish(failure: string | undefined): Promise<never> {
  record.outcome = failure === undefined ? "passed" : "failed";
  if (failure !== undefined) record.failure = failure;
  record.finishedAt = new Date().toISOString();
  if (stack) {
    record.processLogTails = Object.fromEntries(stack.children.map((entry) => [entry.name, entry.log.join("").slice(-4_000)]));
    await Bun.write(join(OUT, `${LABEL}.server.log`), stack.children.find((entry) => entry.name === "web")?.log.join("") ?? "");
    await stack.stop(failure !== undefined).catch((error: unknown) => { record.stopError = String(error); });
  }
  await Bun.write(join(OUT, `${LABEL}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ label: LABEL, mode: MODE, control: CONTROL, outcome: record.outcome, failure: record.failure ?? null }));
  process.exit(failure === undefined ? 0 : 1);
}

process.on("uncaughtException", (error) => { void finish(`harness error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); });
process.on("unhandledRejection", (error) => { void finish(`harness error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); });

async function step(label: string, run: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown }> {
  const result = await run().catch((error: unknown) => ({ status: 0, body: String(error) }));
  steps.push({ label, status: result.status, body: result.body });
  return result;
}

const key = () => `w19a-${crypto.randomUUID()}`;

// ── Which pin this pass runs under ──────────────────────────────────────
// The proof pins the mode's model. The no-pin control admits `infer` with no
// pin at all. The missing-model control pins, registers, and asks for a model
// the host's Ollama does not have.
const pin: FactoryModelPin | undefined = CONTROL === "no-pin" ? undefined
  : CONTROL === "missing-model" ? graphModelPin("ollama", OLLAMA_MISSING_MODEL)
  : modePin(MODE);
// The installation's provider: the mode's, or the missing model's.
const installationPin = CONTROL === "missing-model" ? { provider: "ollama", model: OLLAMA_MISSING_MODEL } : { provider: modePin(MODE).provider, model: modePin(MODE).model };
record.pin = pin ?? null;
record.installationModelProvider = installationPin;

const stores = await checkSharedStores();
record.sharedStores = stores;
if (stores.some((store) => !store.reachable)) await finish(`a shared object store is not available: ${JSON.stringify(stores)}`);

let build: GraphGuestBuild | undefined;
stack = await startStack({
  repo: REPO, bun: BUN, record,
  modelProvider: installationPin,
  buildGuest: async (runnerRoot) => { build = await buildGraphGuest(REPO, runnerRoot, "w19a-guest-supervisor-store"); return { guest: build.guest, sourceDigest: build.sourceDigest }; },
  runnerProfiles: () => graphRunnerProfiles(graphReferences(build!.guest, pin), pin),
  // The mock mode's provider is the product's own in-process fake, which only
  // resolves with the test surface open. The ollama mode leaves it closed.
  webEnv: MODE === "mock" ? { PI_E2E_REAL: "1", EZCORP_ALLOW_TEST_SURFACE: "1" } : {},
});
if (!record.ready) await finish(`the server never reported ready: ${JSON.stringify({ orchestration: record.orchestration, hostProcesses: record.hostProcesses })}`);
const api = stack.session;
const references = graphReferences(build!.guest, pin);

await step("auth.setup", () => api.call("POST", "/api/auth/setup", { name: "W19a Proof", email: "w19a-proof@example.invalid", password: "W19a-Proof-Password-9!" }));
const project = await step("projects.create", () => api.call("POST", "/api/projects", { name: "w19a-proof", path: join(stack!.root, "project") }));
const projectId = (project.body as { id?: string } | undefined)?.id;
const me = await step("auth.me", () => api.call("GET", "/api/auth/me"));
const adminId = (me.body as { user?: { id?: string } } | undefined)?.user?.id;
if (!projectId || !adminId) await finish(`the project or administrator could not be created: ${JSON.stringify(steps)}`);

// ── Register the host's Ollama the way the settings page does ───────────
// The page probes the URL through the guarded local-provider route, then
// writes `provider:customModels`. Main #300 widened that guard so a
// containerized app may name the host gateway; this server runs on the host,
// so the loopback URL the page auto-fills passes the guard unchanged.
if (installationPin.provider === "ollama") {
  const listed = await step("providers.local.models", () => api.call("POST", "/api/providers/local/models", { baseUrl: OLLAMA_URL }));
  record.ollamaListed = listed.body;
  await step("settings.customModels", () => api.call("PUT", "/api/settings/provider:customModels", { value: [{ modelId: installationPin.model, provider: "ollama", tier: "balanced", baseUrl: OLLAMA_URL }] }));
}

// ── Install the runner package: one package, three references ───────────
{
  const productSql = new SQL(stack.productUrl, { max: 2 });
  try {
    const { drizzle } = await import(join(REPO, "node_modules/drizzle-orm/bun-sql/index.js"));
    const schema = await import(join(REPO, "src/db/schema.ts"));
    record.packageInstall = await installGraphGuest({
      repo: REPO, database: drizzle(productSql, { schema }), tenantId: TENANT, projectId: projectId!, adminId: adminId!,
      runnerRoot: join(stack.root, "prepare"), releaseBlobRoot: join(stack.runnerRoot, "release-blobs"), build: build!,
      references: [references.prepare, references.infer, references.combine] as unknown as Record<string, unknown>[],
    });
  } catch (error) {
    await finish(`the runner package could not be installed: ${String(error)}`);
  } finally {
    await productSql.close();
  }
}

// ── The compile-time control: a binding to a port that does not exist ───
// The product keeps an invalid draft (a draft is work in progress) and marks
// it unavailable; the compiler's diagnostics come back from `validate`, and
// publishing the draft is refused.
if (CONTROL === "no-pin") {
  const badId = "w19a.graph.bad-port.v1";
  const bad = graphDefinition({ id: badId, references, badPort: true });
  const validated = await step("control.bad-port.validate", () => api.call("POST", `/api/factories/projects/${projectId}/definitions/${badId}/validate`, { source: bad }));
  const drafted = await step("control.bad-port.draft", () => api.call("POST", `/api/factories/projects/${projectId}/definitions`, { source: bad }, { "If-Match": "0", "Idempotency-Key": key() }));
  const badRevision = (drafted.body as { resource?: { revision?: number } } | undefined)?.resource?.revision;
  const publish = await step("control.bad-port.publish", () => api.call("POST", `/api/factories/projects/${projectId}/definitions/${badId}/versions`, { version: "1.0.0" }, { "If-Match": String(badRevision ?? 1), "Idempotency-Key": key() }));
  const diagnostics = (validated.body as { valid?: boolean; diagnostics?: Array<{ code?: string }> } | undefined);
  record.compileControl = {
    validateStatus: validated.status,
    valid: diagnostics?.valid ?? null,
    diagnosticCodes: (diagnostics?.diagnostics ?? []).map((entry) => entry.code),
    draft: (drafted.body as { resource?: unknown } | undefined)?.resource ?? drafted.body,
    publishStatus: publish.status,
    publishBody: publish.body,
  };
}

// ── The graph, published and run through public HTTP ────────────────────
const factoryId = "w19a.graph.v1";
const definition = graphDefinition({ id: factoryId, references });
record.definition = definition;
const draft = await step("factory.draft.create", () => api.call("POST", `/api/factories/projects/${projectId}/definitions`, { source: definition }, { "If-Match": "0", "Idempotency-Key": key() }));
const revision = (draft.body as { resource?: { revision?: number } } | undefined)?.resource?.revision;
const published = await step("factory.version.publish", () => api.call("POST", `/api/factories/projects/${projectId}/definitions/${factoryId}/versions`, { version: "1.0.0" }, { "If-Match": String(revision ?? 1), "Idempotency-Key": key() }));
const version = (published.body as { resource?: { version?: string; definitionDigest?: string } } | undefined)?.resource;
const grants = await step("factory.grants.list", () => api.call("GET", `/api/factories/projects/${projectId}/grants`));
const runGrant = ((grants.body as { page?: { items?: Array<{ action?: string; revision?: number }> } } | undefined)?.page?.items ?? []).find((item) => item.action === "factory.run");
const started = await step("factory.run.start", () => api.call("POST", `/api/factories/projects/${projectId}/definitions/${factoryId}/runs`, {
  factoryVersion: version?.version, definitionDigest: version?.definitionDigest, grantRevision: runGrant?.revision,
  parameters: { topic: { kind: "inline", value: GRAPH_TOPIC } },
}, { "If-Match": "0", "Idempotency-Key": key() }));
const runId = (started.body as { receipt?: { resourceId?: string } } | undefined)?.receipt?.resourceId;
if (started.status !== 202 || !runId) await finish(`the run was not accepted through public HTTP: ${JSON.stringify(started)}`);

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const timeline: string[] = [];
let runResource: unknown;
// A failed model call carries no usage, so its attempt's cost is unknown and
// C03 holds the run rather than settle an unknown cost as zero. That hold is
// named in the server log by the reconciliation role; the missing-model
// control waits for the name instead of for a terminal status that cannot come.
const HOLD = "factory_usage_hold_unresolved: no-operation-receipt";
const webLog = () => stack!.children.find((entry) => entry.name === "web")?.log.join("") ?? "";
let held = false;
for (let attempt = 0; attempt < 600; attempt++) {
  const polled = await api.call("GET", `/api/factories/projects/${projectId}/runs/${runId}`);
  runResource = (polled.body as { resource?: unknown } | undefined)?.resource;
  const status = (runResource as { status?: string } | undefined)?.status;
  if (status !== undefined && timeline.at(-1) !== status) timeline.push(status);
  if (status !== undefined && TERMINAL.has(status)) break;
  if (CONTROL === "missing-model" && webLog().includes(HOLD)) { held = true; break; }
  await sleep(1_000);
}
record.run = { runId, timeline, terminal: TERMINAL.has(timeline.at(-1) ?? "") ? timeline.at(-1) : null, heldBy: held ? HOLD : null, resource: runResource };

// ── The evidence, from the product database and the object store ───────
const NODES = ["prepare", "infer", "combine"] as const;
type NodeName = (typeof NODES)[number];
const nodeOf = (instance: string): NodeName | undefined => NODES.find((node) => instance === node || instance.startsWith(`${node}:`) || instance.startsWith(`${node}#`) || instance.endsWith(`/${node}`));
const parsed = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;

const probe = new SQL(stack.productUrl, { max: 2 });
const evidence: Record<string, unknown> = {};
try {
  const executions = await probe.unsafe(`SELECT attempt_id, node_instance_id, candidate_generation, attempt_number, status, journal_cursor, request_json FROM factory_executions ORDER BY node_instance_id, attempt_id`) as Array<Record<string, unknown>>;
  const launches = await probe.unsafe(`SELECT attempt_id, state, terminal_result_json FROM factory_attempt_launches ORDER BY attempt_id`) as Array<Record<string, unknown>>;
  const operations = await probe.unsafe(`SELECT attempt_id, operation_id, operation_index, kind, state, request_digest, result_digest, provider_receipt_digest, usage_json, result_json FROM factory_execution_operations ORDER BY attempt_id, operation_index`) as Array<Record<string, unknown>>;
  const completions = await probe.unsafe(`SELECT command_id, attempt_id, receipt_json FROM factory_task_completions ORDER BY command_id`) as Array<Record<string, unknown>>;
  const outcomes = await probe.unsafe(`SELECT command_id, attempt_id, result_json FROM factory_task_outcomes ORDER BY command_id`) as Array<Record<string, unknown>>;
  const artifacts = await probe.unsafe(`SELECT object_id, run_id, candidate_node_instance_id, candidate_generation, digest, encoded_bytes FROM factory_artifacts WHERE kind = 'candidate_output' ORDER BY candidate_node_instance_id`) as Array<Record<string, unknown>>;
  const commands = await probe.unsafe(`SELECT command_id, source_sequence FROM factory_transition_commands ORDER BY source_sequence, command_id`) as Array<Record<string, unknown>>;
  const projections = await probe.unsafe(`SELECT consumer_id, sequence, payload FROM factory_run_projections ORDER BY sequence`) as Array<Record<string, unknown>>;
  const queue = await probe.unsafe(`SELECT attempt_id, state, failure_code FROM factory_attempt_queue ORDER BY attempt_id`) as Array<Record<string, unknown>>;

  // Candidate outputs, read back through the product's own artifact class,
  // restricted to `candidate_output`, under the scope that sealed each one.
  const { loadFactoryStartupConfig } = await import(join(REPO, "src/factory/startup-config.ts"));
  const { loadFactoryStorageCredentials } = await import(join(REPO, "src/factory/release-composition.ts"));
  const { S3BlobStore } = await import(join(REPO, "src/extensions/v4/blobs.ts"));
  const { FactoryArtifacts } = await import(join(REPO, "src/factory/artifacts.ts"));
  const { drizzle } = await import(join(REPO, "node_modules/drizzle-orm/bun-sql/index.js"));
  const schema = await import(join(REPO, "src/db/schema.ts"));
  const config = await loadFactoryStartupConfig(join(stack.root, "secrets", "factory-startup.json"));
  const blobs = new S3BlobStore({ endpoint: config.storage.ordinary.endpoint, bucket: config.storage.ordinary.bucket, prefix: config.storage.ordinary.prefix, credentials: { ...await loadFactoryStorageCredentials(config.storage.ordinary, config.tenantId) } });
  const store = new FactoryArtifacts(drizzle(probe, { schema }), blobs, TENANT);

  const nodes: Record<string, Record<string, unknown>> = {};
  for (const node of NODES) {
    const execution = executions.find((row) => nodeOf(String(row.node_instance_id)) === node);
    if (!execution) { nodes[node] = { ran: false }; continue; }
    const attemptId = String(execution.attempt_id);
    const request = parsed(execution.request_json);
    const launch = launches.find((row) => row.attempt_id === attemptId);
    const result = launch?.terminal_result_json ? parsed(launch.terminal_result_json) : undefined;
    const artifact = artifacts.find((row) => nodeOf(String(row.candidate_node_instance_id)) === node);
    let stored: unknown;
    if (artifact) {
      const loaded = await store.load({ tenantId: TENANT, projectId: projectId!, logicalRunId: String(artifact.run_id) }, { objectId: String(artifact.object_id), digest: String(artifact.digest), encodedBytes: Number(artifact.encoded_bytes) }, ["candidate_output"]);
      stored = JSON.parse(new TextDecoder().decode(loaded.content));
    }
    const completion = completions.find((row) => row.attempt_id === attemptId);
    const outcome = outcomes.find((row) => row.attempt_id === attemptId);
    nodes[node] = {
      ran: true,
      attemptId,
      nodeInstanceId: execution.node_instance_id,
      executionStatus: execution.status,
      journalCursor: Number(execution.journal_cursor),
      runner: request.runner,
      model: request.model ?? null,
      input: request.input,
      launchState: launch?.state ?? null,
      result: result ?? null,
      candidateOutput: artifact ? { artifactId: artifact.object_id, digest: artifact.digest, encodedBytes: Number(artifact.encoded_bytes), runId: artifact.run_id, candidateNodeInstanceId: artifact.candidate_node_instance_id, candidateGeneration: Number(artifact.candidate_generation), objectName: GRAPH_GUEST_OUTPUT } : null,
      stored: stored ?? null,
      completionEventOutput: completion ? (parsed(completion.receipt_json).event as { output?: unknown } | undefined)?.output ?? null : null,
      outcomeResult: outcome ? parsed(outcome.result_json) : null,
      operations: operations.filter((row) => row.attempt_id === attemptId).map((row) => ({
        operationId: row.operation_id, operationIndex: Number(row.operation_index), kind: row.kind, state: row.state,
        requestDigest: row.request_digest, resultDigest: row.result_digest, providerReceiptDigest: row.provider_receipt_digest,
        usage: row.usage_json === null ? null : parsed(row.usage_json), result: row.result_json === null ? null : parsed(row.result_json),
      })),
    };
  }
  evidence.nodes = nodes;
  evidence.queue = queue;
  evidence.commands = commands.map((row) => row.command_id);
  evidence.projections = projections.map((row) => ({ consumer: row.consumer_id, sequence: Number(row.sequence), payload: String(row.payload).slice(0, 2_000) }));
} catch (error) {
  evidence.error = String(error);
} finally {
  await probe.close();
}
record.evidence = evidence;
record.readiness = (record.ready as { body?: { detail?: { factory?: Record<string, unknown> } } } | null)?.body?.detail?.factory ?? null;

// ── The verdict for this pass ───────────────────────────────────────────
type Node = { ran: boolean; stored?: Record<string, unknown> | null; input?: { value?: unknown }; completionEventOutput?: unknown; operations?: Array<Record<string, unknown>>; result?: Record<string, unknown> | null; model?: Record<string, unknown> | null; candidateOutput?: Record<string, unknown> | null };
const nodes = (evidence.nodes ?? {}) as Record<NodeName, Node>;
const checks: Array<{ check: string; ok: boolean; detail?: unknown }> = [];
const expect = (check: string, ok: boolean, detail?: unknown) => { checks.push({ check, ok, ...(ok ? {} : { detail }) }); };
// Canonical JSON: a jsonb column returns its keys in its own order.
const same = (left: unknown, right: unknown) => left !== undefined && right !== undefined && canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);

if (CONTROL === "none") {
  const [a, b, c] = [nodes.prepare, nodes.infer, nodes.combine];
  expect("the run projected succeeded", (record.run as { terminal?: string }).terminal === "succeeded", timeline);
  expect("every node ran once", NODES.every((node) => nodes[node]?.ran === true), Object.fromEntries(NODES.map((node) => [node, nodes[node]?.ran])));
  const count = a?.stored?.count as number | undefined;
  const answer = b?.stored?.answer as string | undefined;
  expect("C.summary equals the value computed from A.count and B.answer, all read from the store", typeof count === "number" && typeof answer === "string" && c?.stored?.summary === combineSummary(count, answer), { count, answer, summary: c?.stored?.summary });
  expect("C was dispatched with exactly A.count and B.answer", same(c?.input?.value, { count, answer }), { input: c?.input?.value });
  expect("B was dispatched with exactly A.text", same(b?.input?.value, { text: a?.stored?.text }), { input: b?.input?.value });
  expect("each completion carried the bytes the store holds", NODES.every((node) => same(nodes[node]?.completionEventOutput, nodes[node]?.stored)));
  const bOperations = b?.operations ?? [];
  expect("B's journal shows exactly one model operation, completed", bOperations.length === 1 && bOperations[0]?.kind === "model" && bOperations[0]?.state === "completed", bOperations);
  const usage = bOperations[0]?.usage as { inputTokens?: number; outputTokens?: number; kind?: string } | undefined;
  expect("B's operation carries measured usage with tokens", usage?.kind === "measured" && (usage.inputTokens ?? 0) > 0 && (usage.outputTokens ?? 0) > 0, usage);
  expect("B ran under the pinned provider and model", b?.model?.provider === pin?.provider && b?.model?.model === pin?.model && same(b?.model?.configuration, pin?.configuration), b?.model);
  expect("A and C settled no operation", (a?.operations ?? []).length === 0 && (c?.operations ?? []).length === 0);
  expect("B's staged usage is the journal's usage", same(b?.stored?.usage, { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens }), b?.stored?.usage);
} else {
  const [b, c] = [nodes.infer, nodes.combine];
  expect("C never ran", c?.ran === false, c);
  const error = (b?.result as { error?: { code?: string; message?: string } } | null)?.error;
  if (CONTROL === "no-pin") {
    expect("the run ended failed", (record.run as { terminal?: string }).terminal === "failed", timeline);
    expect("B ran with no model pin", b?.ran === true && b?.model === null, b?.model);
    expect("B was refused model_pin_mismatch by the broker", error?.code === "model_pin_mismatch", error);
    expect("nothing was claimed or journaled for B", (b?.operations ?? []).length === 0, b?.operations);
    const compile = record.compileControl as { valid?: boolean | null; diagnosticCodes?: string[]; publishStatus?: number; publishBody?: { error?: { code?: string; issues?: Array<{ code?: string }> } }; draft?: { availability?: string } } | undefined;
    expect("the compiler refused the missing port by name, BINDING_PORT", compile?.valid === false && (compile.diagnosticCodes ?? []).includes("BINDING_PORT"), compile);
    expect("the invalid draft is unavailable, and publishing it is refused 422 factory_definition_invalid naming BINDING_PORT",
      compile?.draft?.availability === "unavailable" && compile.publishStatus === 422 && compile.publishBody?.error?.code === "factory_definition_invalid"
        && (compile.publishBody.error.issues ?? []).some((issue) => issue.code === "BINDING_PORT"), compile);
  } else {
    expect("B was refused provider_unavailable", error?.code === "provider_unavailable", error);
    expect("the refusal carries Ollama's own missing-model message", String(error?.message ?? "").includes(`model '${OLLAMA_MISSING_MODEL}' not found`), error);
    const operations = b?.operations ?? [];
    const failure = operations[0]?.result as { code?: string; message?: string } | undefined;
    expect("the provider error is journaled as B's one failed model operation", operations.length === 1 && operations[0]?.kind === "model" && operations[0]?.state === "failed" && failure?.code === "factory_guest_model_failed" && String(failure?.message).includes("not found"), operations);
    // Not a pass condition of the control; a finding it records. The failed row
    // has no usage, so the attempt's cost is unknown and the run is held.
    record.heldRunFinding = { held, timeline, reason: held ? HOLD : null };
  }
}
record.checks = checks;
const failed = checks.filter((entry) => !entry.ok).map((entry) => entry.check);
await finish(failed.length === 0 ? undefined : `checks failed: ${failed.join("; ")}`);
