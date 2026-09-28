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
}

const TENANT_NUMBER = /^tenant-(\d{2})$/;

export function factoryInstallationPorts(tenantId: string, portBase: number): FactoryInstallationPorts {
  const match = TENANT_NUMBER.exec(tenantId);
  if (!match || !Number.isSafeInteger(portBase) || portBase < 1_024 || portBase + 100 * 10 > 65_535) throw new FactoryProvisioningError("deployment_ports_invalid", "Installation ports cannot be derived.");
  const base = portBase + Number(match[1]) * 10;
  return Object.freeze({ harness: base, privateService: base + 1, gateway: base + 2, guestBroker: base + 3 });
}
