import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { resourcePaths } from "./commands";

export class ResourceRoot {
  constructor(readonly root: string) {}
  async verifyPrivateRoot(): Promise<void> { const value = await stat(this.root); if (!value.isDirectory() || value.uid !== process.getuid?.() || (value.mode & 0o077) !== 0) throw new Error("stateRoot must be an owned private directory"); }
  paths(id: string) { return resourcePaths(this.root, id); }
  async initialize(id: string): Promise<ReturnType<typeof resourcePaths>> { const paths = this.paths(id); await mkdir(paths.root, { recursive: false, mode: 0o700 }); return paths; }
  async writeMetadata(id: string, value: unknown): Promise<void> {
    const paths = this.paths(id); const temporary = `${paths.metadata}.${crypto.randomUUID()}.new`;
    try {
      const file = await open(temporary, "wx", 0o600); try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temporary, paths.metadata); const directory = await open(paths.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  async readMetadata<T>(id: string): Promise<T> {
    const file = await open(this.paths(id).metadata, "r"); try { const size = (await file.stat()).size; if (size > 64 * 1024) throw new Error("metadata is oversized"); const data = Buffer.alloc(size + 1); const { bytesRead } = await file.read(data, 0, data.length, 0); if (bytesRead > size) throw new Error("metadata changed while reading"); return JSON.parse(data.subarray(0, bytesRead).toString("utf8")) as T; } finally { await file.close(); }
  }
  async destroy(id: string): Promise<void> { await rm(this.paths(id).root, { recursive: true }); }
}
