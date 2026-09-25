import { describe, expect, test } from "bun:test";
import { compileFactory } from "@ezcorp/factory-sdk/compiler";
import { factoryModelPinMatchesRunner } from "./native-runner-policy";
import { factoryModelSamplingOptions } from "./model-configuration";
import { parseFactoryStartupConfig } from "./startup-config";
import { GRAPH_RESOURCE_CLASSES, graphDefinition, graphReferences, graphRunnerProfiles, modePin, OLLAMA_MISSING_MODEL, graphModelPin } from "../../scripts/factory-graph-proof/graph";

/**
 * The W19a proof graph, compiled and admitted exactly as the harness submits it.
 *
 * The real-server proof takes minutes and a shared lock; a definition or a
 * profile the product refuses should fail here in milliseconds instead, and
 * the compile-time control must be refused by the same name there and here.
 */

const guest = { package: "@ezcorp/w19a-graph-guest", manifestName: "w19a-graph-guest", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };

function startup(profiles: unknown, modelProvider?: { provider: string; model: string }): Record<string, unknown> {
  const storage = (kind: string) => ({ endpoint: `http://127.0.0.1:1833${kind === "ordinary" ? 3 : 4}`, bucket: "tenant-01", prefix: kind, credentialSet: kind, credentialsPath: `/run/secrets/${kind}.json` });
  return {
    schemaVersion: "factory.startup.v1", installationId: "installation-w19a", tenantId: "tenant-01", poolId: "pool-w19a", hostId: "host-w19a",
    temporalNamespace: "tenant-01.factory", orphanSweepIntervalMs: 30_000,
    orchestrationReadinessFilePath: "/run/r/o.json", poolReadinessFilePath: "/run/r/p.json", supervisorReadinessFilePath: "/run/r/s.json", readinessHeartbeatMs: 5_000,
    gateway: { hostname: "127.0.0.1", port: 1, tls: { caPath: "/c", certificatePath: "/c", privateKeyPath: "/c" } },
    privateService: { hostname: "127.0.0.1", port: 2, certificateIdentity: "tenant-a", tls: { caPath: "/c", certificatePath: "/c", privateKeyPath: "/c" } },
    pool: { baseUrl: "https://127.0.0.1:3", serviceTokenPath: "/t", tls: { caPath: "/c", certificatePath: "/c", privateKeyPath: "/c" } },
    storage: { ordinary: storage("ordinary"), archive: storage("archive") },
    keys: { masterKeyFilePath: "/k", masterKeyId: "master-1", wrappedKeyFilePath: "/w", grantableRoots: ["/p"] },
    runnerProfiles: profiles,
    ...(modelProvider === undefined ? {} : { modelProvider }),
  };
}

describe("the W19a proof graph", () => {
  for (const mode of ["ollama", "mock"] as const) {
    test(`compiles in mode ${mode}, with every wired value a reference`, () => {
      const references = graphReferences(guest, modePin(mode));
      const definition = graphDefinition({ id: "w19a.graph.v1", references });
      const compiled = compileFactory(definition);
      expect(compiled.ok, JSON.stringify(compiled.ok ? [] : compiled.diagnostics)).toBe(true);
      const nodes = (definition.graph as { nodes: Array<{ id: string; bindings: Record<string, { kind: string }> }> }).nodes;
      for (const node of nodes) for (const binding of Object.values(node.bindings)) expect(binding.kind).toBe("ref");
      expect((definition.graph as { outputs: Record<string, unknown> }).outputs).toEqual({ summary: { kind: "ref", root: "node", name: "combine", path: ["summary"] } });
    });
  }

  test("the two modes differ only in infer's model pin", () => {
    const ollama = graphDefinition({ id: "w19a.graph.v1", references: graphReferences(guest, modePin("ollama")) });
    const mock = graphDefinition({ id: "w19a.graph.v1", references: graphReferences(guest, modePin("mock")) });
    const strip = (definition: Record<string, unknown>) => {
      const copy = structuredClone(definition) as { graph: { nodes: Array<{ runner: Record<string, unknown> }> } };
      for (const node of copy.graph.nodes) { delete node.runner.model; delete node.runner.configurationDigest; }
      return copy;
    };
    expect(strip(ollama)).toEqual(strip(mock));
    expect(ollama).not.toEqual(mock);
    expect(modePin("ollama").configuration).toEqual(modePin("mock").configuration);
    expect(factoryModelSamplingOptions(modePin("ollama").configuration)).toEqual({ temperature: 0, samplingParams: { seed: 42, reasoning_effort: "none" } });
  });

  test("a binding to an output port that does not exist is refused at compile, by name", () => {
    const compiled = compileFactory(graphDefinition({ id: "w19a.graph.bad-port.v1", references: graphReferences(guest, modePin("mock")), badPort: true }));
    expect(compiled.ok).toBe(false);
    expect(compiled.ok ? [] : compiled.diagnostics.map(entry => entry.code)).toContain("BINDING_PORT");
  });

  test("the profiles the harness declares are admitted by the startup document, pinned or not", () => {
    for (const pin of [modePin("ollama"), modePin("mock"), graphModelPin("ollama", OLLAMA_MISSING_MODEL)]) {
      const references = graphReferences(guest, pin);
      const config = parseFactoryStartupConfig(startup(graphRunnerProfiles(references, pin), { provider: pin.provider, model: pin.model }));
      expect(config.runnerProfiles?.profiles.map(profile => profile.resourceClass)).toEqual(Object.values(GRAPH_RESOURCE_CLASSES));
      expect(factoryModelPinMatchesRunner(references.infer, pin)).toBe(true);
    }
    const unpinned = graphReferences(guest, undefined);
    expect(parseFactoryStartupConfig(startup(graphRunnerProfiles(unpinned, undefined))).runnerProfiles?.profiles[1]?.model).toBeUndefined();
  });
});
