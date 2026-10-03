import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { PodmanRunner } from "../src/podman";
import type { FramedTransport } from "../src/protocol";

/** Reaches the private channel helpers without loosening their visibility in production. */
export class ChannelHost extends PodmanRunner {
  private reach<Value>(name: string, id: string): Value { return (this as unknown as Record<string, (id: string) => Value>)[name]!.call(this, id); }
  directory(id: string): string { return this.reach("channelDirectory", id); }
  facts(id: string): string { return this.reach("channelFactsPath", id); }
  transport(id: string): Promise<FramedTransport> { return this.reach("channelTransport", id); }
}

export interface EchoGuest { readonly guest: ChildProcess; readonly transport: FramedTransport; readonly echoed: Promise<string>; readonly closed: Promise<"closed"> }

/**
 * A shell guest on a real channel, connected through the real `channelTransport`.
 *
 * It opens all three FIFOs read-write as the sandbox shim does, so no open waits
 * for the host, echoes the first frame on `out`, and exits on the next line.
 * A guest with `reads: false` never reads `in`, as a hostile guest may not.
 * `timeout` bounds it, so none outlives a failed run. Both reads run from the
 * start, as FramedExecution reads both for a worker's whole life.
 */
export async function echoGuest(host: ChannelHost, id: string, { reads = true }: { reads?: boolean } = {}): Promise<EchoGuest> {
  const directory = host.directory(id);
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o755);
  const facts: Record<string, { device: number; inode: number }> = {};
  for (const fifo of ["in", "out", "err"]) {
    Bun.spawnSync(["mkfifo", "-m", "666", join(directory, fifo)]);
    const created = await lstat(join(directory, fifo));
    facts[fifo] = { device: created.dev, inode: created.ino };
  }
  await writeFile(host.facts(id), JSON.stringify(facts), { mode: 0o600 });
  const script = reads ? 'head -n1 <&3 >&4; read -r _ <&3' : "sleep 60";
  const guest = spawn("timeout", ["30", "sh", "-c", `exec 3<>"$0/in" 4<>"$0/out" 5<>"$0/err"; ${script}`, directory], { stdio: "ignore" });
  const transport = await host.transport(id);
  transport.stderr.on("data", () => {});
  const echoed = new Promise<string>(resolve => transport.stdout.on("data", chunk => resolve(String(chunk).trim())));
  const closed = new Promise<"closed">(resolve => transport.once("close", () => resolve("closed")));
  return { guest, transport, echoed, closed };
}
