import type { ShellProvider, ShellOptions, ShellResult } from "../types";

export function createShellProvider(): ShellProvider {
  return {
    async run(command: string, opts?: ShellOptions): Promise<ShellResult> {
      const spawnOpts: Record<string, unknown> = {
        cmd: ["sh", "-c", command],
        stdout: "pipe",
        stderr: "pipe",
      };
      if (opts?.cwd) spawnOpts.cwd = opts.cwd;

      const proc = Bun.spawn(spawnOpts as any);

      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      if (opts?.timeout) {
        const timer = setTimeout(() => proc.kill(), opts.timeout);
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        return { stdout, stderr, exitCode };
      }

      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    },
  };
}
