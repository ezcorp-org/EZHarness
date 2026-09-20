import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resourcePaths } from "./commands";

export class ResourceRoot {
  constructor(readonly root: string) {}
  paths(id: string) { return resourcePaths(this.root, id); }
  async initialize(id: string): Promise<ReturnType<typeof resourcePaths>> { const paths = this.paths(id); await mkdir(paths.root, { recursive: false, mode: 0o700 }); return paths; }
  async writeMetadata(id: string, value: unknown): Promise<void> {
    const paths = this.paths(id); const temporary = `${paths.metadata}.new`;
    const file = await open(temporary, "wx", 0o600); try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, paths.metadata);
  }
  async readMetadata<T>(id: string): Promise<T> { const raw = await readFile(this.paths(id).metadata, "utf8"); if (raw.length > 64 * 1024) throw new Error("metadata is oversized"); return JSON.parse(raw) as T; }
}
