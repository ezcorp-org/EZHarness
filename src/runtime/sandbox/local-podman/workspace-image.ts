import { mkdir, rm, stat } from "node:fs/promises";
import type { LocalPodmanHostConfig } from "./commands";

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${err.trim()}`);
  return out;
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
    const proc = Bun.spawn(["e2fsck", "-p", "-f", image], { stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0 && code !== 1) throw new Error(`e2fsck exited ${code}: ${await new Response(proc.stderr).text()}`);
  }
  async destroy(image: string, mount: string): Promise<void> {
    try { await this.unmount(mount); } finally { await rm(image, { force: true }); await rm(mount, { recursive: true, force: true }); }
  }
  async allocatedBytes(image: string): Promise<number> { return (await stat(image)).blocks * 512; }
}
