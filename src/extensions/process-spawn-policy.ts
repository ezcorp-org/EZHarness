/**
 * Which extension workers may start other processes, decided by the host for
 * every start it asks a runner for.
 *
 * "allow" needs one of two things: the shell grant, or a release whose code is
 * only the sealed SDK MCP bridge for one stdio server (which must start that
 * server). Everything else is "deny", and a "deny" start goes only to a runner
 * that says it enforces it: a runner from before the guard, or one that could
 * not install it, would ignore the field and let the worker spawn.
 */
import { canonicalJson, ContractError, declaresStdioMcpServer, isPureStdioMcpSource, workspaceText } from "@ezcorp/extension-contract";
import type { ProcessSpawnPolicy, ReleaseRecord, Runner } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";

/** The installation grant that lets a worker start other processes. */
export const SHELL_GRANT = canonicalJson(["shell", true]);

/** An artifact never changes under its digest, so neither does its verdict. */
const bridgeVerdicts = new Map<string, boolean>();

/** Reads the verdict from the digest-checked artifact: its sources and the entrypoint its recipe recorded. */
async function isPureMcpBridgeRelease(runner: Runner, release: Pick<ReleaseRecord, "artifactDigest" | "manifest">): Promise<boolean> {
  if (!declaresStdioMcpServer(release.manifest)) return false;
  const known = bridgeVerdicts.get(release.artifactDigest);
  if (known !== undefined) return known;
  const files = await runner.collectArtifacts(release.artifactDigest);
  if (filesDigest(files) !== release.artifactDigest) throw new ContractError("ARTIFACT_CORRUPT", "Release artifact does not match its digest");
  const recipe = JSON.parse(workspaceText(files[".runner/recipe.json"], ".runner/recipe.json")) as { entrypoint?: unknown };
  const verdict = typeof recipe.entrypoint === "string" && isPureStdioMcpSource(files, recipe.entrypoint);
  bridgeVerdicts.set(release.artifactDigest, verdict);
  return verdict;
}

/** Refuses a "deny" start on a runner that does not advertise enforcement. */
export async function requireProcessSpawnEnforcement(runner: Runner, policy: ProcessSpawnPolicy): Promise<void> {
  if (policy === "allow") return;
  if ((await runner.capabilities?.())?.processSpawnEnforcement !== true) throw new ContractError("PROCESS_SPAWN_UNENFORCED", "The extension runner cannot block process creation, so an extension without the shell permission cannot start. Update the extension runner.");
}

/**
 * The policy for one release worker, checked against the runner that will
 * start it. `shellGranted` is the installation's grant at runtime, and the
 * release's own declaration where the worker runs before or for its approval.
 */
export async function releaseProcessSpawn(runner: Runner, release: Pick<ReleaseRecord, "artifactDigest" | "manifest">, shellGranted: boolean): Promise<ProcessSpawnPolicy> {
  const policy: ProcessSpawnPolicy = shellGranted || await isPureMcpBridgeRelease(runner, release) ? "allow" : "deny";
  await requireProcessSpawnEnforcement(runner, policy);
  return policy;
}
