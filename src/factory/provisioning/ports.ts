/**
 * The loopback ports of one installation, derived from its tenant number.
 *
 * A leaf: the deployment renderer and the fleet host both need it, and the
 * host must not import the renderer (the renderer imports the host).
 */
import { FactoryProvisioningError } from "./steps";

export interface FactoryInstallationPorts {
  readonly harness: number;
  readonly privateService: number;
  readonly gateway: number;
  /** W01g's guest-broker route, bound by the harness; the fleet host's supervisor carries staging frames to it. */
  readonly guestBroker: number;
  /** Each tenant process's `/metrics` (C11 M4), scraped by the fleet's evaluator on loopback. */
  readonly harnessMetrics: number;
  readonly gatewayMetrics: number;
  readonly orchestratorMetrics: number;
}

const TENANT_NUMBER = /^tenant-(\d{2})$/;

/**
 * The fleet's own ports, as offsets from `portBase`, above every tenant's
 * (`portBase + 10*n` to `+6`, n up to 99). One table, so a new fleet port
 * cannot land on an existing one (C11 added the last three; W4H-34).
 */
export const FACTORY_FLEET_PORT_OFFSETS = Object.freeze({
  temporal: 1_001, pool: 1_002, supervisor: 1_003, temporalHttp: 1_004, ingress: 1_005,
  poolMetrics: 1_006, supervisorMetrics: 1_007, prometheus: 1_008,
});

export function factoryInstallationPorts(tenantId: string, portBase: number): FactoryInstallationPorts {
  const match = TENANT_NUMBER.exec(tenantId);
  if (!match || !Number.isSafeInteger(portBase) || portBase < 1_024 || portBase + 100 * 10 > 65_535) throw new FactoryProvisioningError("deployment_ports_invalid", "Installation ports cannot be derived.");
  const base = portBase + Number(match[1]) * 10;
  return Object.freeze({
    harness: base, privateService: base + 1, gateway: base + 2, guestBroker: base + 3,
    harnessMetrics: base + 4, gatewayMetrics: base + 5, orchestratorMetrics: base + 6,
  });
}
