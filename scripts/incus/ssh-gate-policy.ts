#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { validateManifest, type SandboxPreset } from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { INCUS_INVENTORY_COMMANDS, incusCapacityCommands } from "./inspect";
import type { IncusImageBootstrapPlan, IncusInventory, IncusSetupPlan, IncusSetupRecipe } from "./model";
import { assertExactKeys, assertRecord, assertSafeName, assertSha256, assertSetupPlanDigest, digest } from "./model";
import { createImageBootstrapPlan, createSetupPlan, validateRecipe } from "./plan";

export interface SshGatePolicy {
  version: 1;
  ownedNeighborChallenge?: OwnedNeighborChallengeScope;
  planDigest: string;
  issuedAt?: string;
  writeExpiresAt?: string;
  commands: Array<{ argv: string[]; stdinSha256?: string; write?: true }>;
}

export interface OwnedNeighborChallengeScope {
  connectionId: string;
  project: string;
  profile: string;
  incusProfile: string;
  network: string;
  bridgeCIDR: string;
  presetId: string;
  imageFingerprint: string;
}

export function ownedNeighborScope(recipe: IncusSetupRecipe, connectionId: string, presetId: string): OwnedNeighborChallengeScope {
  validateRecipe(recipe);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(connectionId)) throw new Error("Invalid reviewed connection ID");
  const manifest = validateManifest(incusManifest);
  const preset = manifest.sandboxProviders?.find(value => value.id === "incus")?.presets.find(value => value.id === presetId);
  if (!preset || preset.imageDigest !== recipe.guestImage?.fingerprint) throw new Error("Reviewed preset and recipe image must match");
  return { connectionId, project: recipe.project.name, profile: preset.profile, incusProfile: recipe.profile.name,
    network: recipe.network.name, bridgeCIDR: recipe.network.config["ipv4.address"]!,
    presetId: preset.id, imageFingerprint: preset.imageDigest };
}

/** A reviewed capability adds only the closed owned-neighbor challenge, never general sockets or writes. */
export function createOwnedNeighborChallengeSshPolicy(scope: OwnedNeighborChallengeScope): SshGatePolicy {
  assertRecord(scope, "owned neighbor scope");
  assertExactKeys(scope, ["connectionId", "project", "profile", "incusProfile", "network", "bridgeCIDR", "presetId", "imageFingerprint"], "owned neighbor scope");
  for (const key of ["project", "incusProfile", "network"] as const) assertSafeName(scope[key], key);
  for (const key of ["connectionId", "profile", "presetId"] as const) {
    if (typeof scope[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(scope[key])) throw new Error("Invalid owned neighbor identity");
  }
  assertSha256(scope.imageFingerprint, "owned neighbor image");
  if (scope.project === "default" || typeof scope.bridgeCIDR !== "string" ||
    !/^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(scope.bridgeCIDR) ||
    !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[2-9]|[12][0-9]|30)$/.test(scope.bridgeCIDR) ||
    scope.bridgeCIDR.split("/")[0]!.split(".").some(value => Number(value) > 255) ||
    Number(scope.bridgeCIDR.split("/")[1]) < (scope.bridgeCIDR.startsWith("10.") ? 8 : scope.bridgeCIDR.startsWith("172.") ? 12 : 16)) throw new Error("Invalid owned neighbor bridge");
  const bootstrap = createReadOnlySshGatePolicy();
  const ownedNeighborChallenge = { ...scope };
  return { ...bootstrap, ownedNeighborChallenge,
    planDigest: digest({ purpose: "owned-neighbor-challenge", version: 1, commands: bootstrap.commands, ownedNeighborChallenge }) };
}

export const SSH_GATE_WRITE_LIFETIME_MS = 15 * 60_000;

/** First install this policy so an operator can inspect and plan through the gate. It has no writes. */
export function createReadOnlySshGatePolicy(): SshGatePolicy {
  const commands = INCUS_INVENTORY_COMMANDS.map(argv => ({ argv: [...argv] }));
  return { version: 1, planDigest: digest({ purpose: "read-only-bootstrap", version: 1, commands }), commands };
}

/** Generate an exact command policy from the recipe, inventory, and reviewed plan. */
export function createSshGatePolicy(recipe: IncusSetupRecipe, inventory: IncusInventory,
  plan: IncusSetupPlan | IncusImageBootstrapPlan, presets?: readonly SandboxPreset[], issuedAt = new Date()): SshGatePolicy {
  assertSetupPlanDigest(plan);
  if (plan.status !== "ready" || plan.sshMode !== "reviewed-envelope-v1" ||
    inventory.connection.sshMode !== "reviewed-envelope-v1") throw new Error("A ready reviewed SSH gate plan is required");
  const current = "purpose" in plan ? createImageBootstrapPlan(recipe, inventory, presets) : createSetupPlan(recipe, inventory, presets);
  if (current.planDigest !== plan.planDigest) throw new Error("Reviewed SSH gate plan differs from recipe or inventory");
  const commands = [...INCUS_INVENTORY_COMMANDS.map(argv => ({ argv: [...argv] })),
    ...incusCapacityCommands(recipe.storage.name).map(argv => ({ argv })),
    ...plan.steps.flatMap(step => [
      { argv: step.inspect.argv },
      { argv: step.apply.argv, write: true as const, ...(step.apply.stdin === undefined ? {} :
        { stdinSha256: createHash("sha256").update(step.apply.stdin).digest("hex") }) },
    ])];
  const unique = new Map<string, SshGatePolicy["commands"][number]>();
  for (const command of commands) unique.set(JSON.stringify(command), command);
  if (!Number.isFinite(issuedAt.getTime())) throw new Error("SSH gate policy issue time is invalid");
  return { version: 1, planDigest: plan.planDigest, issuedAt: issuedAt.toISOString(),
    writeExpiresAt: new Date(issuedAt.getTime() + SSH_GATE_WRITE_LIFETIME_MS).toISOString(), commands: [...unique.values()] };
}

async function main(): Promise<void> {
  const inputs = process.argv.slice(2);
  const neighbor = inputs[0] === "--owned-neighbor-challenge";
  if ((!neighbor && (inputs.length !== 2 || inputs[0] !== "--read-only-bootstrap")) || (neighbor && inputs.length !== 5)) {
    throw new Error("usage: ssh-gate-policy.ts --read-only-bootstrap OUTPUT | --owned-neighbor-challenge RECIPE CONNECTION_ID PRESET_ID OUTPUT");
  }
  const policy = neighbor ? createOwnedNeighborChallengeSshPolicy(ownedNeighborScope(
    JSON.parse(await readFile(inputs[1]!, "utf8")), inputs[2]!, inputs[3]!)) : createReadOnlySshGatePolicy();
  await writeFile(inputs[neighbor ? 4 : 1]!, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Read-only SSH gate policy ${policy.planDigest}: ${policy.commands.length} exact commands`);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
