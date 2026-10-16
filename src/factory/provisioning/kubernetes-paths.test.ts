import { expect, test } from "bun:test";
import { FACTORY_KUBERNETES_SUPERVISOR_PATHS, factoryKubernetesServiceUrl } from "./kubernetes-paths";

test("a cluster service is dialled by its full in-cluster name", () => {
  expect(factoryKubernetesServiceUrl("factory-pool", "ezcorp-factory-system", 41_002)).toBe("https://factory-pool.ezcorp-factory-system.svc.cluster.local:41002");
});

test("the supervisor's container paths are fixed and frozen", () => {
  expect(FACTORY_KUBERNETES_SUPERVISOR_PATHS).toEqual({ secrets: "/run/ezcorp/host-identity", readinessDirectory: "/run/ezcorp/readiness/supervisor", runnerRoot: "/var/lib/ezcorp-factory/runner" });
  expect(Object.isFrozen(FACTORY_KUBERNETES_SUPERVISOR_PATHS)).toBe(true);
});
