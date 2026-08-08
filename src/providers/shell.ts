import type { ShellProvider, ShellOptions, ShellResult } from "../types";

export function createShellProvider(): ShellProvider {
  return {
    async run(command: string, opts?: ShellOptions): Promise<ShellResult> {
      // Spread the optional `cwd` inline rather than building a
      // `Record<string, unknown>` and casting it: the record erased the
      // literal `"pipe"` types Bun.spawn overloads on, which is the only
      // reason the call needed a cast at all.
      const proc = Bun.spawn({
        cmd: ["sh", "-c", command],
        stdout: "pipe",
        stderr: "pipe",
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      });

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
