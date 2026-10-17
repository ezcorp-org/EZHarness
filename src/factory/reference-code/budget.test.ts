/**
 * W4H-28 budget ruling: reference.code.v1's declared task costs, held against the host's run limits by the real
 * budget store, in the order the run admits them. A real model's spend in generate must leave freeze admissible.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { referenceCodeV1, type FactoryDefinition, type FactoryNode } from "@ezcorp/factory-sdk";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "../../db/migrations/add-factory-budgets";
import { FactoryBudgets, type FactoryBudgetAmount } from "../budgets";
import { FACTORY_HOST_RUN_LIMITS } from "../boot";
import { FactoryRecords } from "../records";
import { factoryTaskReservationAmount } from "../task-admission";

type Task = Extract<FactoryNode, { kind: "task" }>;
const tenantId = "budget-tenant", projectId = "budget-project";
const receipt = `sha256:${"a".repeat(64)}`;
// The worst allocation a fleet may give a cpu task: the run's whole cap (the local fleet's allocation is exactly that).
const allocation = { costMicros: FACTORY_HOST_RUN_LIMITS.maxCostMicros, tokens: 50_000, computeMs: 600_000 };
// What a real model call in generate may cost: far more than gpt-6-luna's few thousand micros.
const generateSpend: FactoryBudgetAmount = { costMicros: "30000", tokens: 12_000, computeMs: 20_000 };
const nothing: FactoryBudgetAmount = { costMicros: "0", tokens: 0, computeMs: 1_000 };

let fixture: Awaited<ReturnType<typeof setupTestDb>>;
let records: FactoryRecords;
let budgets: FactoryBudgets;
let runId: string, sequence = 0;
const now = Date.UTC(2030, 0, 1);

beforeAll(async () => {
  fixture = await setupTestDb();
  await up(fixture.db);
  records = new FactoryRecords(fixture.db, tenantId);
  await records.bindInstallation();
  await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${projectId}, 'Budget project', '/tmp/budget-project')`);
  await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name) VALUES ('budget-human', 'budget@example.test', 'not-a-login', 'Budget human')`);
  await records.bindProject(projectId);
  budgets = new FactoryBudgets(fixture.db, tenantId, async () => {}, () => now);
});
afterAll(async () => { await fixture?.pglite.close(); });
beforeEach(async () => {
  runId = `budget-run-${++sequence}`;
  await records.createRun({ projectId, runId, definitionDigest: receipt, interpreterBuild: "v1", executionEpoch: 1, principalId: "budget-human", input: {} }, async () => {});
  await budgets.openEnvelope({ projectId, runId, envelopeId: "root", limits: FACTORY_HOST_RUN_LIMITS, deadlineAtMs: now + 3_600_000 });
});

/** Admits each task in run order, as task admission would, and settles it with its spend. */
async function admitInOrder(definition: FactoryDefinition, spend: (nodeId: string) => FactoryBudgetAmount): Promise<string[]> {
  const admitted: string[] = [];
  for (const node of definition.graph.nodes.filter((item): item is Task => item.kind === "task")) {
    const request = { projectId, runId, envelopeId: "root", reservationId: `${runId}:${node.id}`, amount: factoryTaskReservationAmount(node.resources, allocation), computeRequest: { cpu: 1 } };
    await budgets.reserve(request, async () => {});
    await budgets.settle(request, spend(node.id), receipt);
    admitted.push(node.id);
  }
  return admitted;
}

test("generate's model spend leaves freeze and the protected checks admissible", async () => {
  expect(await admitInOrder(referenceCodeV1, id => id === "generate-private-candidate" ? generateSpend : nothing)).toEqual(["snapshot-repository", "generate-private-candidate", "freeze-complete-git-tree", "protected-checks"]);
  expect((await budgets.inspect({ projectId, runId, envelopeId: "root" })).spent.costMicros).toBe("30000");
});

test("a task that declares no cost holds the allocation's whole cost, so any earlier spend refuses it by name", async () => {
  const undeclared = { ...referenceCodeV1, graph: { ...referenceCodeV1.graph, nodes: referenceCodeV1.graph.nodes.map(node => node.kind === "task" ? { ...node, resources: undefined } : node) } } as FactoryDefinition;
  expect(factoryTaskReservationAmount(undefined, allocation).costMicros).toBe(FACTORY_HOST_RUN_LIMITS.maxCostMicros);
  await expect(admitInOrder(undeclared, id => id === "generate-private-candidate" ? generateSpend : nothing)).rejects.toMatchObject({ code: "factory_budget_exhausted" });
});

test("a declared cost above the allocation is held at the allocation, never above it", () => {
  expect(factoryTaskReservationAmount({ maxCostMicros: "5000000", maxTokens: 90_000, maxComputeMs: 9_000_000 }, allocation)).toEqual(allocation);
  expect(factoryTaskReservationAmount({ maxCostMicros: "250000" }, allocation)).toEqual({ ...allocation, costMicros: "250000" });
});
