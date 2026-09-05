import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { encodeWorkspaceFile, isWorkspaceTextPath, validateWorkspaceFiles, workspaceText, type WorkspaceFiles } from "@ezcorp/extension-contract";

export interface FirstPartyExtensionSource {
  name: string;
  directory: string;
  entrypoint: "extension.ts";
}

export interface SourceSnapshot {
  source: FirstPartyExtensionSource;
  files: WorkspaceFiles;
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
  return snapshotExtensionSource(projectRoot, source);
}

export async function snapshotExtensionSource(projectRoot: string, source: FirstPartyExtensionSource): Promise<SourceSnapshot> {
  const root = await realpath(projectRoot);
  const sourceRoot = resolve(root, source.directory);
  if (!sourceRoot.startsWith(root + sep)) throw new Error("Extension source escaped project root");
  const files: WorkspaceFiles = Object.create(null);
  let bytes = 0;
  let directories = 0;
  let entryCount = 0;

  async function collect(directory: Awaited<ReturnType<typeof open>>, prefix = "", depth = 0): Promise<void> {
    if (depth > 128 || ++directories > MAX_FILES) throw new Error("Extension source directory limit exceeded");
    const anchoredDirectory = `/proc/self/fd/${directory.fd}`;
    const entries: Dirent[] = [];
    for await (const entry of await opendir(anchoredDirectory)) {
      if (++entryCount > MAX_FILES) throw new Error("Extension source entry limit exceeded");
      entries.push(entry);
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name === ".env" || entry.name.startsWith(".env.")) continue;
      const path = join(anchoredDirectory, entry.name);
      const filePath = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Source links are not permitted: ${filePath}`);
      if (entry.isDirectory()) {
        const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await collect(child, `${filePath}/`, depth + 1); } finally { await child.close(); }
        continue;
      }
      if (!entry.isFile()) throw new Error(`Source must contain regular files only: ${filePath}`);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Invalid source file or file limit exceeded: ${filePath}`);
        if (stat.nlink !== 1) throw new Error(`Hard-linked source files are not permitted: ${filePath}`);
        const chunks: Buffer[] = [];
        let fileBytes = 0;
        for (;;) {
          const chunk = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(chunk);
          if (bytesRead === 0) break;
          fileBytes += bytesRead;
          if (fileBytes > MAX_FILE_BYTES) throw new Error(`Source file grew beyond its limit: ${filePath}`);
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const contents = Buffer.concat(chunks);
        bytes += contents.byteLength;
        if (bytes > MAX_SOURCE_BYTES || Object.keys(files).length >= MAX_FILES) throw new Error("Extension source limit exceeded");
        files[filePath] = encodeWorkspaceFile(contents, !isWorkspaceTextPath(filePath) && (stat.mode & 0o111) !== 0);
      } finally {
        await handle.close();
      }
    }
  }

  let sourceDirectory = await open(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of sourceRoot.split(sep).filter(Boolean)) {
      const child = await open(`/proc/self/fd/${sourceDirectory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await sourceDirectory.close();
      sourceDirectory = child;
    }
    await collect(sourceDirectory);
  } finally { await sourceDirectory.close(); }
  if (!files[source.entrypoint]) throw new Error(`Missing v4 entrypoint: ${source.directory}/${source.entrypoint}`);
  workspaceText(files[source.entrypoint], source.entrypoint);
  validateWorkspaceFiles(files);
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
