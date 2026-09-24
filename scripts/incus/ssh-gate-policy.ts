#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { SandboxPreset } from "@ezcorp/extension-contract";
import { INCUS_INVENTORY_COMMANDS, incusCapacityCommands } from "./inspect";
import type { IncusImageBootstrapPlan, IncusInventory, IncusSetupPlan, IncusSetupRecipe } from "./model";
import { assertSetupPlanDigest, digest } from "./model";
import { createImageBootstrapPlan, createSetupPlan } from "./plan";

export interface SshGatePolicy {
  version: 1;
  planDigest: string;
  commands: Array<{ argv: string[]; stdinSha256?: string }>;
}

/** First install this policy so an operator can inspect and plan through the gate. It has no writes. */
export function createReadOnlySshGatePolicy(): SshGatePolicy {
  const commands = INCUS_INVENTORY_COMMANDS.map(argv => ({ argv: [...argv] }));
  return { version: 1, planDigest: digest({ purpose: "read-only-bootstrap", version: 1, commands }), commands };
}

/** Generate an exact command policy from the recipe, inventory, and reviewed plan. */
export function createSshGatePolicy(recipe: IncusSetupRecipe, inventory: IncusInventory,
  plan: IncusSetupPlan | IncusImageBootstrapPlan, presets?: readonly SandboxPreset[]): SshGatePolicy {
  assertSetupPlanDigest(plan);
  if (plan.status !== "ready" || plan.sshMode !== "reviewed-envelope-v1" ||
    inventory.connection.sshMode !== "reviewed-envelope-v1") throw new Error("A ready reviewed SSH gate plan is required");
  const current = "purpose" in plan ? createImageBootstrapPlan(recipe, inventory, presets) : createSetupPlan(recipe, inventory, presets);
  if (current.planDigest !== plan.planDigest) throw new Error("Reviewed SSH gate plan differs from recipe or inventory");
  const commands = [...INCUS_INVENTORY_COMMANDS.map(argv => ({ argv: [...argv] })),
    ...incusCapacityCommands(recipe.storage.name).map(argv => ({ argv })),
    ...plan.steps.flatMap(step => [
      { argv: step.inspect.argv },
      { argv: step.apply.argv, ...(step.apply.stdin === undefined ? {} :
        { stdinSha256: createHash("sha256").update(step.apply.stdin).digest("hex") }) },
    ])];
  const unique = new Map<string, SshGatePolicy["commands"][number]>();
  for (const command of commands) unique.set(JSON.stringify(command), command);
  return { version: 1, planDigest: plan.planDigest, commands: [...unique.values()] };
}

async function main(): Promise<void> {
  const inputs = process.argv.slice(2);
  if (inputs.length !== 2 || inputs[0] !== "--read-only-bootstrap") {
    throw new Error("usage: ssh-gate-policy.ts --read-only-bootstrap OUTPUT");
  }
  const policy = createReadOnlySshGatePolicy();
  await writeFile(inputs[1]!, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Read-only SSH gate policy ${policy.planDigest}: ${policy.commands.length} exact commands`);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
