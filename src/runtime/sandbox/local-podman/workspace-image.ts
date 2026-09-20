import { mkdir, rm, stat } from "node:fs/promises";
import { runBoundedCommand, type LocalPodmanHostConfig } from "./commands";

async function run(argv: string[]): Promise<string> {
  const result = await runBoundedCommand(argv, { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (result.code !== 0 || result.timedOut) throw new Error(`${argv[0]} failed`);
  return result.stdout;
}

export class WorkspaceImage {
  constructor(private readonly config: LocalPodmanHostConfig) {}
  async create(image: string, mount: string, bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 * 1024) throw new Error("invalid workspace size");
    await mkdir(mount, { recursive: true, mode: 0o700 });
    await run(["truncate", "-s", String(bytes), image]);
    await run(["mkfs.ext2", "-q", "-F", "-m", "0", image]);
    await this.mount(image, mount);
  }
  async mount(image: string, mount: string): Promise<void> { await run([this.config.fuse2fsPath, "-o", "fakeroot", image, mount]); }
  async unmount(mount: string): Promise<void> { await run(["fusermount3", "-u", mount]); }
  async check(image: string): Promise<void> {
    const result = await runBoundedCommand(["e2fsck", "-p", "-f", image], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (result.timedOut || (result.code !== 0 && result.code !== 1)) throw new Error("e2fsck failed");
  }
  async destroy(image: string, mount: string): Promise<void> {
    await this.unmount(mount); await rm(image); await rm(mount, { recursive: true });
  }
  async allocatedBytes(image: string): Promise<number> { return (await stat(image)).blocks * 512; }
}
