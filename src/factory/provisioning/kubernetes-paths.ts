/**
 * Names the hosted profile's renderer (`kubernetes-profile.ts`) and the fleet
 * host's documents (`host.ts`) must agree on, kept in one leaf with no imports
 * so neither module imports the other (W4H-35).
 */

/** Where the supervisor DaemonSet sees its delivery copy and writes its readiness. Its runner root is a fleet setting (`kubernetes.runnerRoot`). */
export const FACTORY_KUBERNETES_SUPERVISOR_PATHS = Object.freeze({
  secrets: "/run/ezcorp/host-identity",
  readinessDirectory: "/run/ezcorp/readiness/supervisor",
});

/** The supervisor's durable state folder under the runner root (C12 row "Supervisor durable state (hosted)"), prepared by its init container. */
export const FACTORY_KUBERNETES_SUPERVISOR_STATE = "supervisor-state";

/** A cluster service's HTTPS address as a pod dials it. */
export function factoryKubernetesServiceUrl(service: string, namespace: string, port: number): string {
  return `https://${service}.${namespace}.svc.cluster.local:${port}`;
}
