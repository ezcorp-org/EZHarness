/**
 * The supervisor's one product role that waits instead of degrading (C12 row "Container runtime readiness (hosted)"): it is held,
 * with `runnerReady` false, while the container runtime does not answer.
 *
 * A leaf module with no imports: the metric registry reads it, and the orchestrator loads the registry under Node, whose type
 * removal is strip-only and whose loader needs explicit extensions (scripts/factory-node-entries-registration.test.ts).
 */
export const FACTORY_CONTAINER_RUNTIME_ROLE = Object.freeze({ role: "container-runtime", workPackage: "W16" });
