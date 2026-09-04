import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface FirstPartyExtensionSource {
  name: string;
  directory: string;
  entrypoint: "extension.ts";
}

export interface SourceSnapshot {
  source: FirstPartyExtensionSource;
  files: Record<string, string>;
  bytes: number;
}

const SOURCE_ROOTS = ["extensions", "docs/extensions/examples", "packages/@ezcorp"];
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".ezcorp", "dist", "coverage", ".svelte-kit", "test-results", "playwright-report"]);
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export async function listFirstPartyExtensionSources(projectRoot: string): Promise<FirstPartyExtensionSource[]> {
  const sources: FirstPartyExtensionSource[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const directory = join(projectRoot, sourceRoot);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const configPath = join(directory, entry.name, "ezcorp.config.ts");
      const config = await lstat(configPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!config) continue;
      if (!config.isFile()) throw new Error(`Extension config must be a regular file: ${configPath}`);
      sources.push({ name: entry.name, directory: `${sourceRoot}/${entry.name}`, entrypoint: "extension.ts" });
    }
  }
  return sources.sort((left, right) => left.directory.localeCompare(right.directory));
}

export async function snapshotFirstPartyExtension(projectRoot: string, sourceName: string): Promise<SourceSnapshot> {
  const sources = await listFirstPartyExtensionSources(projectRoot);
  const matches = sources.filter((source) => source.name === sourceName);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous first-party extension: ${sourceName}`);
  const source = matches[0]!;
  const root = await realpath(projectRoot);
  const sourceRoot = await realpath(join(root, source.directory));
  if (!sourceRoot.startsWith(root + sep)) throw new Error("Extension source escaped project root");
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  async function collect(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name === ".env" || entry.name.startsWith(".env.")) continue;
      const path = join(directory, entry.name);
      const filePath = relative(sourceRoot, path).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Source links are not permitted: ${filePath}`);
      if (entry.isDirectory()) {
        if (!(await realpath(path)).startsWith(sourceRoot + sep)) throw new Error(`Source directory escaped: ${filePath}`);
        await collect(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Source must contain regular files only: ${filePath}`);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Invalid source file or file limit exceeded: ${filePath}`);
        const contents = await handle.readFile();
        bytes += contents.byteLength;
        if (bytes > MAX_SOURCE_BYTES || Object.keys(files).length >= MAX_FILES) throw new Error("Extension source limit exceeded");
        files[filePath] = decoder.decode(contents);
      } finally {
        await handle.close();
      }
    }
  }

  await collect(sourceRoot);
  if (!files[source.entrypoint]) throw new Error(`Missing v4 entrypoint: ${source.directory}/${source.entrypoint}`);
  return { source, files, bytes };
}

if (import.meta.main) {
  const projectRoot = resolve(dirname(import.meta.path), "..");
  const sourceName = process.argv[2];
  const result = sourceName
    ? await snapshotFirstPartyExtension(projectRoot, sourceName)
    : await listFirstPartyExtensionSources(projectRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
