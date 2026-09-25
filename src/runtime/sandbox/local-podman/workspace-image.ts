import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { runBoundedCommand, type LocalPodmanHostConfig } from "./commands";

async function run(argv: string[]): Promise<string> {
  const result = await runBoundedCommand(argv, { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (result.code !== 0 || result.timedOut) throw new Error(`${argv[0]} failed`);
  return result.stdout;
}

export class WorkspaceImage {
  constructor(private readonly config: LocalPodmanHostConfig, private readonly tools: { truncate: string; mkfs: string; unmount: string; check: string; readMountInfo?: () => Promise<string> } = { truncate: "truncate", mkfs: "mkfs.ext2", unmount: "fusermount3", check: "e2fsck" }) {}
  private async mounted(mount: string): Promise<boolean> {
    const mountInfo = await (this.tools.readMountInfo?.() ?? readFile("/proc/self/mountinfo", "utf8"));
    const escapes: Record<string, string> = { "040": " ", "011": "\t", "012": "\n", "134": "\\" };
    return mountInfo.split("\n").some((line) => line.split(" ")[4]?.replace(/\\(040|011|012|134)/g, (_, code: string) => escapes[code]!) === mount);
  }
  async create(image: string, mount: string, bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 * 1024) throw new Error("invalid workspace size");
    await mkdir(mount, { recursive: true, mode: 0o700 });
    await run([this.tools.truncate, "-s", String(bytes), image]);
    await run([this.tools.mkfs, "-q", "-F", "-m", "0", image]);
    await this.mount(image, mount);
  }
  async recoverCreate(image: string, mount: string, bytes: number): Promise<void> {
    if (await this.mounted(mount)) return;
    await rm(image, { force: true }); await rm(mount, { recursive: true, force: true }); await this.create(image, mount, bytes);
  }
  async mount(image: string, mount: string): Promise<void> { await run([this.config.fuse2fsPath, "-o", "fakeroot", image, mount]); }
  async unmount(mount: string): Promise<void> { await run([this.tools.unmount, "-u", mount]); }
  async check(image: string): Promise<void> {
    const result = await runBoundedCommand([this.tools.check, "-p", "-f", image], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (result.timedOut || (result.code !== 0 && result.code !== 1)) throw new Error("e2fsck failed");
  }
  async destroy(image: string, mount: string): Promise<void> {
    if (await this.mounted(mount)) {
      await this.unmount(mount);
      if (await this.mounted(mount)) throw new Error("workspace remained mounted after unmount");
    }
    await rm(image, { force: true }); await rm(mount, { recursive: true, force: true });
  }
  async allocatedBytes(image: string): Promise<number> { return (await stat(image)).blocks * 512; }
}
