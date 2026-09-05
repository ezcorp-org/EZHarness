import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { relativePath, RunnerError } from "./core";

interface LockedPackage { version: string; resolved: string; integrity: string; dependencies?: Record<string, string> }
interface PackageLock { lockfileVersion: 3; packages: Record<string, LockedPackage | { dependencies?: Record<string, string> }> }
const registry = "https://registry.npmjs.org/";
const exactVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const maximumArchive = 20 * 1024 ** 2;
const maximumClosure = 100 * 1024 ** 2;

async function registryBytes(url: string, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.origin !== new URL(registry).origin || parsed.username || parsed.password) throw new RunnerError("registry_denied", "Dependencies must come from the approved npm registry", "dependencies");
  const response = await fetch(parsed, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new RunnerError("dependency_unavailable", `Registry returned ${response.status}`, "dependencies", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw new RunnerError("dependency_limit", "Registry response exceeds policy", "dependencies");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

function declaredDependencies(files: WorkspaceFiles): Record<string, string> {
  if (!files["package.json"]) return {};
  const manifest = JSON.parse(files["package.json"]);
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, version] of Object.entries(dependencies)) {
    if (!packageName.test(name) || name === "@ezcorp/sdk" || name === "@ezcorp/extension-contract" || typeof version !== "string" || !exactVersion.test(version)) throw new RunnerError("dependency_unpinned", "Dependencies require exact versions; SDK is runner-provisioned", "dependencies");
  }
  return dependencies;
}

export async function resolveDependencies(files: WorkspaceFiles): Promise<WorkspaceFiles> {
  const dependencies = declaredDependencies(files);
  const packages: PackageLock["packages"] = { "": { dependencies } };
  const pending = Object.entries(dependencies).map(([name, version]) => ({ name, version, path: `node_modules/${name}` }));
  while (pending.length) {
    if (Object.keys(packages).length > 200) throw new RunnerError("dependency_limit", "Dependency count exceeds policy", "dependencies");
    const next = pending.shift();
    if (!next) break;
    if (!packageName.test(next.name) || next.name.startsWith("@ezcorp/")) throw new RunnerError("dependency_denied", "Dependency name is reserved or invalid", "dependencies");
    const metadata = JSON.parse(new TextDecoder().decode(await registryBytes(`${registry}${encodeURIComponent(next.name)}`, maximumArchive)));
    const versions = Object.keys(metadata.versions ?? {});
    const version = exactVersion.test(next.version) ? next.version : versions.filter(version => Bun.semver.satisfies(version, next.version)).sort((left, right) => Bun.semver.order(right, left))[0];
    if (!version) throw new RunnerError("dependency_unavailable", "Dependency version is missing", "dependencies");
    const release = metadata.versions?.[version];
    if (!release || !exactVersion.test(version) || typeof release.dist?.integrity !== "string" || !release.dist.integrity.startsWith("sha512-")) throw new RunnerError("dependency_unavailable", "Dependency version or integrity is missing", "dependencies");
    const locked: LockedPackage = { version, resolved: release.dist.tarball, integrity: release.dist.integrity, ...(release.dependencies ? { dependencies: release.dependencies } : {}) };
    packages[next.path] = locked;
    for (const [name, constraint] of Object.entries(release.dependencies ?? {})) {
      if (typeof constraint !== "string") throw new RunnerError("invalid_dependency", "Invalid dependency constraint", "dependencies");
      const ancestors = next.path.split("/node_modules/");
      let alreadyResolved = false;
      for (let depth = ancestors.length; depth >= 0; depth--) {
        const candidate = depth === 0 ? `node_modules/${name}` : `${ancestors.slice(0, depth).join("/node_modules/")}/node_modules/${name}`;
        const existing = packages[candidate];
        if (existing && "version" in existing && Bun.semver.satisfies(existing.version, constraint)) { alreadyResolved = true; break; }
      }
      if (!alreadyResolved) pending.push({ name, version: constraint, path: `${next.path}/node_modules/${name}` });
    }
  }
  return { ...files, "package-lock.json": `${JSON.stringify({ lockfileVersion: 3, packages }, null, 2)}\n` };
}

export function extractPackage(archive: Uint8Array): Record<string, Uint8Array> {
  const tar = gunzipSync(archive, { maxOutputLength: maximumClosure });
  const result: Record<string, Uint8Array> = Object.create(null);
  let archiveRoot: string | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const storedChecksum = Number.parseInt(string(148, 8).trim(), 8);
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
    if (storedChecksum !== checksum) throw new RunnerError("archive_invalid", "Invalid tar checksum", "dependencies");
    const prefix = string(345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${string(0, 100)}`;
    const type = string(156, 1);
    const sizeString = string(124, 12).trim();
    const size = Number.parseInt(sizeString, 8);
    if (!/^[0-7]+$/.test(sizeString) || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new RunnerError("archive_invalid", "Invalid tar entry size", "dependencies");
    if (type !== "0" && type !== "" && type !== "5") throw new RunnerError("archive_unsafe", "Links, devices, and extended tar entries are not supported", "dependencies");
    const normalized = name.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
    const parts = relativePath(normalized).split("/");
    const root = parts.shift()!;
    if (archiveRoot !== undefined && archiveRoot !== root) throw new RunnerError("archive_unsafe", "Tar entries must share one package root", "dependencies");
    archiveRoot = root;
    if (type !== "5") {
      const path = relativePath(parts.join("/"));
      if (Object.hasOwn(result, path)) throw new RunnerError("archive_duplicate", "Duplicate tar entry", "dependencies");
      result[path] = tar.subarray(offset + 512, offset + 512 + size);
      if (Object.keys(result).length > 10_000) throw new RunnerError("dependency_limit", "Archive file count exceeds policy", "dependencies");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

export async function fetchLockedDependencies(files: WorkspaceFiles, signal?: AbortSignal): Promise<{ text: WorkspaceFiles; binary: Record<string, Uint8Array>; executable: string[] }> {
  const declared = declaredDependencies(files);
  if (Object.keys(declared).length === 0) return { text: {}, binary: {}, executable: [] };
  if (!files["package-lock.json"]) throw new RunnerError("lockfile_required", "Resolve dependencies into a workspace revision before building", "dependencies");
  const lock: PackageLock = JSON.parse(files["package-lock.json"]);
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object" || Object.keys(lock.packages).length > 201) throw new RunnerError("lockfile_invalid", "Expected bounded npm lockfile version 3", "dependencies");
  const roots = lock.packages[""]?.dependencies ?? {};
  if (JSON.stringify(Object.entries(roots).sort()) !== JSON.stringify(Object.entries(declared).sort())) throw new RunnerError("lockfile_stale", "Package dependencies differ from the frozen lockfile", "dependencies");
  for (const [name, version] of Object.entries(declared)) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || !("version" in entry) || entry.version !== version) throw new RunnerError("lockfile_stale", "Direct dependency version differs from lock", "dependencies");
  }
  const binary: Record<string, Uint8Array> = Object.create(null);
  const executable: string[] = [];
  let bytes = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    signal?.throwIfAborted();
    if (path === "") continue;
    relativePath(path);
    if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/.test(path) || path.includes("@ezcorp/")) throw new RunnerError("lockfile_invalid", "Invalid dependency location", "dependencies");
    if (!("version" in entry) || !exactVersion.test(entry.version) || typeof entry.integrity !== "string" || !/^sha512-[a-zA-Z0-9+/]{86}==$/.test(entry.integrity)) throw new RunnerError("lockfile_invalid", "Dependency requires exact version and SHA-512 integrity", "dependencies");
    const archive = await registryBytes(entry.resolved, maximumArchive, signal);
    if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== entry.integrity) throw new RunnerError("dependency_integrity", "Dependency archive integrity mismatch", "dependencies");
    const extracted = extractPackage(archive);
    const manifest = JSON.parse(new TextDecoder().decode(extracted["package.json"]));
    if (manifest.version !== entry.version || path.split("/node_modules/").at(-1)?.replace(/^node_modules\//, "") !== manifest.name) throw new RunnerError("dependency_identity", "Package identity differs from lock", "dependencies");
    const binaries = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
    for (const binary of binaries) {
      if (typeof binary !== "string") throw new RunnerError("dependency_identity", "Invalid package binary declaration", "dependencies");
      const binaryPath = relativePath(binary.replace(/^\.\//, ""));
      if (!Object.hasOwn(extracted, binaryPath)) throw new RunnerError("dependency_identity", "Declared binary is missing", "dependencies");
      executable.push(`${path}/${binaryPath}`);
    }
    for (const [name, content] of Object.entries(extracted)) {
      bytes += content.byteLength;
      if (bytes > maximumClosure) throw new RunnerError("dependency_limit", "Dependency closure exceeds policy", "dependencies");
      binary[`${path}/${name}`] = content;
    }
  }
  return { text: {}, binary, executable };
}
