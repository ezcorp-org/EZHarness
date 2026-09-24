export * from "./types";
export * from "./controller";

import { SandboxControllerError, type LocalSandboxDriver, type SandboxController, type SandboxProviderInvocation } from "./types";
import { createSandboxController } from "./controller";
import type { ReleaseRuntimeDependencies } from "../../../extensions/release-process";

let controller: SandboxController | undefined;

/** Install the host-owned driver during startup before any route can dispatch. */
export function configureSandboxController(driver: LocalSandboxDriver, runtime?: Pick<ReleaseRuntimeDependencies, "resolve">, invoke?: SandboxProviderInvocation): SandboxController {
  controller = createSandboxController(driver, runtime, invoke);
  return controller;
}

/** Routes fail closed until startup supplies the local host driver. */
export function getSandboxController(): SandboxController {
  if (!controller) throw new SandboxControllerError("SANDBOX_CONTROLLER_UNAVAILABLE", "Local sandbox controller is not configured");
  return controller;
}
