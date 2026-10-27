/**
 * The hosted profile's private-path judge (C12 row "Private paths of a hosted container (hosted)"), for the renderer's tests.
 *
 * A private path is every absolute path a container's own documents, environment or command name under the product's
 * private roots (the delivered secrets and the readiness records). Each is judged against the container's RENDERED mounts:
 * the pod's real deliver-secrets command runs in a temporary root first, then the product's own privatePathWalk walks the
 * path's directory (image directories and a kubelet emptyDir root modelled, the rest as the command made it). A read walks the
 * directory as privateDirectory does; the container's own `readinessFilePath` is a write and walks it as
 * writePrivateBoundedAtomic does (create the leaf below an owned directory; repair an owned leaf). A write on a read-only mount, and
 * durable state on an emptyDir, are refused by name; an operator-prepared hostPath of type Directory is owned by the reader (the
 * C12 prerequisites row), any other volume root the kubelet's. A read whose directory holds
 * files the init command delivered also reads every one of them with the real readPrivateBounded (owned, regular, private). A
 * path that no mount covers is a refusal too, so a missing mount turns the judge red by construction.
 */
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { privatePathWalk, readPrivateBounded } from "../../factory/private-files";

export type KubernetesObject = Readonly<Record<string, unknown>>;
interface Mount { readonly name: string; readonly mountPath: string; readonly subPath?: string; readonly readOnly?: boolean }
interface Volume { readonly name: string; readonly emptyDir?: unknown; readonly hostPath?: { readonly path: string; readonly type?: string } }
interface Container { readonly name: string; readonly command?: readonly string[]; readonly volumeMounts?: readonly Mount[] }
interface PodSpec { readonly initContainers?: readonly Container[]; readonly containers: readonly Container[]; readonly volumes?: readonly Volume[] }

/**
 * A path a container uses: whether the container writes it (its own readiness record, its durable state) or only reads it, and
 * whether what it writes must survive a pod restart (C12 row "Supervisor durable state (hosted)").
 */
export interface PrivatePathUse { readonly path: string; readonly write: boolean; readonly durable?: boolean }

/** The kubelet's emptyDir root and an unprepared subPath: root-owned; run 10's verdict on them was "no owned directory". */
const KUBELET_DIRECTORY = { uid: 0, mode: 0o40755 };
/** A directory of the image or of the runtime on a mount path (/run, /run/ezcorp): root-owned, 0755. */
const IMAGE_DIRECTORY = { uid: 0, mode: 0o40755 };

/** Every absolute string under one of `roots` in a document, with whether its key is the writer's own `readinessFilePath`. */
export function privatePathUses(document: unknown, roots: readonly string[]): PrivatePathUse[] {
  const uses: PrivatePathUse[] = [];
  const under = (value: string) => roots.some((root) => value === root || value.startsWith(`${root}/`));
  const visit = (value: unknown, key: string) => {
    if (typeof value === "string") { if (under(value)) uses.push({ path: value, write: key === "readinessFilePath" }); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return; }
    if (value !== null && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, name);
  };
  visit(document, "");
  return uses;
}

/** The pod template of a rendered workload, by kind and name. */
export function podTemplate(stream: readonly KubernetesObject[], kind: string, name: string): PodSpec {
  const object = stream.find((entry) => entry.kind === kind && (entry.metadata as { name: string }).name === name);
  const pod = (object?.spec as { template?: { spec?: PodSpec } } | undefined)?.template?.spec;
  if (!pod) throw new Error(`no pod template for ${kind}/${name}`);
  return pod;
}

/**
 * Judges every use against the pod's rendered mounts. `uses` maps a container name to the paths its own documents name;
 * each container's command arguments under the roots are added as reads. One line per use: "<container> <r|w> <path>: ok"
 * or the reason the product would refuse it.
 */
export async function judgePrivatePaths(pod: PodSpec, uses: Readonly<Record<string, readonly PrivatePathUse[]>>, roots: readonly string[], uid: number): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "w4h35-private-paths-"));
  try {
    const volumes = new Map<string, string>();
    for (const init of pod.initContainers ?? []) {
      for (const mount of init.volumeMounts ?? []) {
        const directory = join(root, mount.mountPath);
        await mkdir(directory, { recursive: true, mode: 0o755 });
        if (mount.mountPath.startsWith("/source/")) for (const name of ["config.json", "client.key"]) await writeFile(join(directory, name), "x", { mode: 0o400 });
        else volumes.set(mount.name, directory);
      }
      const [shell, flag, script] = init.command ?? [];
      const run = Bun.spawnSync([shell!, flag!, script!.replaceAll("/source/", `${root}/source/`).replaceAll("/delivered/", `${root}/delivered/`)]);
      if (run.exitCode !== 0) return [`${init.name}: the init command failed`];
    }
    const lines: string[] = [];
    for (const container of pod.containers) {
      const argumentUses = (container.command ?? []).flatMap((argument) => privatePathUses(argument, roots));
      for (const use of [...(uses[container.name] ?? []), ...argumentUses]) {
        lines.push(`${container.name} ${use.write ? "w" : "r"} ${use.path}: ${await judge(container, use, volumes, pod.volumes ?? [], root, uid)}`);
      }
    }
    return lines;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function judge(container: Container, use: PrivatePathUse, volumes: ReadonlyMap<string, string>, declared: readonly Volume[], root: string, uid: number): Promise<string> {
  const mount = [...(container.volumeMounts ?? [])].filter((entry) => use.path === entry.mountPath || use.path.startsWith(`${entry.mountPath}/`)).sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
  if (!mount) return "no mount covers it";
  const volumeOf = declared.find((volume) => volume.name === mount.name);
  if (use.write && mount.readOnly === true) return "read-only mount";
  if (use.durable === true && volumeOf?.emptyDir !== undefined) return "not durable (emptyDir)";
  const mountRoot = volumeOf?.hostPath?.type === "Directory" ? { uid, mode: 0o40700 } : KUBELET_DIRECTORY;
  // A whole mount point named as a directory (EZCORP_SECRETS_DIR) is walked itself; a file, through its directory.
  const target = use.path === mount.mountPath ? use.path : dirname(use.path);
  const volume = volumes.get(mount.name) ?? join(root, "unprepared", mount.name);
  const base = mount.subPath === undefined ? volume : join(volume, mount.subPath);
  const components = target.split("/").filter(Boolean);
  const depth = mount.mountPath.split("/").filter(Boolean).length;
  const walk = privatePathWalk(uid);
  try {
    for (const [index] of components.entries()) {
      const last = index === components.length - 1;
      const mayRepair = use.write && last;
      if (index < depth - 1) { walk.step(IMAGE_DIRECTORY, mayRepair); continue; }
      const local = join(base, ...components.slice(depth, index + 1));
      const status = await lstat(index === depth - 1 ? base : local).catch(() => undefined);
      if (status === undefined) {
        // The kubelet makes a missing subPath, and a mount point, root-owned; a writer creates a missing leaf below an owned directory.
        if (index === depth - 1) { walk.step(mount.subPath === undefined ? mountRoot : KUBELET_DIRECTORY, mayRepair); continue; }
        if (!use.write || !last || !walk.reachedOwnedDirectory) { walk.step(KUBELET_DIRECTORY, mayRepair); continue; }
        walk.step({ uid, mode: 0o40700 }, mayRepair);
        continue;
      }
      walk.step(index === depth - 1 && mount.subPath === undefined ? mountRoot : status, mayRepair);
    }
    walk.end();
    if (!use.write) {
      const local = join(base, ...components.slice(depth));
      const names = await readdir(local).catch(() => [] as string[]);
      if (names.length > 0) {
        const handle = await open(local, constants.O_RDONLY | constants.O_DIRECTORY);
        try { for (const name of names) await readPrivateBounded(handle, name, 1024); }
        finally { await handle.close(); }
      }
    }
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
}
