/**
 * How a TypeScript spawner reaches the pinned `uv` (W4G-5). The ONE resolution for every TypeScript caller, in the same
 * order scripts/python-quality.sh uses for the shell lanes: `uv` on PATH first (CI installs the pinned one), then
 * `nix-shell -p uv`, then `nix shell nixpkgs#uv`; none of them is a readiness failure by name, never a skip.
 * src/factory/runner/uv-command.test.ts fails if this order and the shell script's order ever differ.
 *
 * The binary is resolved ONCE per process to an absolute path and then spawned directly: a Nix wrapper per call costs
 * seconds each, and a caller that spawns once per fixture would outlive any test timeout.
 */
export const UV_RESOLUTION_ORDER = ["uv", "nix-shell", "nix"] as const;

export class UvUnavailableError extends Error {
  override readonly name = "UvUnavailableError";
}

type Which = (tool: string) => string | null;
/** Runs a command and returns its trimmed stdout, or "" when it fails. */
type Probe = (command: readonly string[]) => string;

const probeCommand: Probe = (command) => {
  const run = Bun.spawnSync([...command], { stdout: "pipe", stderr: "ignore" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : "";
};

/** The absolute path of the uv binary this host provides, in UV_RESOLUTION_ORDER, or a named refusal. */
export function resolveUvBinary(which: Which = Bun.which, probe: Probe = probeCommand): string {
  for (const tool of UV_RESOLUTION_ORDER) {
    const found = which(tool);
    if (!found) continue;
    if (tool === "uv") return found;
    // The probe runs exactly the binary `which` found, never a second PATH lookup of its name.
    const located = tool === "nix-shell"
      ? probe([found, "-p", "uv", "--run", "command -v uv"])
      : probe([found, "shell", "nixpkgs#uv", "-c", "sh", "-c", "command -v uv"]);
    if (located.startsWith("/")) return located;
    throw new UvUnavailableError(`${tool} is on PATH but did not provide uv`);
  }
  throw new UvUnavailableError("no 'uv' available; install uv or provide nix-shell. The Python lanes cannot be skipped.");
}

let resolved: string | undefined;

/** `uv <args>` for Bun.spawn, with the binary resolved once per process. */
export function uvCommand(args: readonly string[]): string[] {
  resolved ??= resolveUvBinary();
  return [resolved, ...args];
}
