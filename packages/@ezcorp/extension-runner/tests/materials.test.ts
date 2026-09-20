import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunnerMaterials, openRunnerMaterial } from "../src/materials";
import { GUEST_MATERIALS_PATH, PodmanRunner, runnerMaterialMount } from "../src/podman";

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ez-materials-"));
  return directory;
}

test("a guest's ordinary files are listed, sorted, and sized", async () => {
  const directory = await root();
  try {
    await writeFile(join(directory, "b.bin"), "second");
    await writeFile(join(directory, "a.bin"), "first");
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "c.bin"), "third!");
    expect(await listRunnerMaterials(directory)).toEqual([
      { path: "a.bin", bytes: 5 },
      { path: "b.bin", bytes: 6 },
      { path: "nested/c.bin", bytes: 6 },
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a symbolic link a guest planted is refused rather than followed", async () => {
  const directory = await root();
  try {
    await writeFile(join(directory, "real.bin"), "ok");
    // Measured on a real guest: the material mount permits this.
    await symlink("/etc/passwd", join(directory, "escape"));
    await expect(listRunnerMaterials(directory)).rejects.toThrow("symbolic link");
    await expect(openRunnerMaterial(directory, "escape")).rejects.toThrow("could not be opened as a regular file");
    // The refusal names the kernel's own reason and reads nothing.
    await expect(openRunnerMaterial(directory, "escape")).rejects.toThrow("ELOOP");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a symbolic link to a directory cannot smuggle a tree in either", async () => {
  const directory = await root();
  const outside = await root();
  try {
    await writeFile(join(outside, "secret.bin"), "not yours");
    await symlink(outside, join(directory, "linked"));
    await expect(listRunnerMaterials(directory)).rejects.toThrow("symbolic link");
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("a path that escapes the material root is refused before anything is opened", async () => {
  const directory = await root();
  try {
    for (const entry of ["../escape", "nested/../../escape", "/etc/passwd", ""]) {
      await expect(openRunnerMaterial(directory, entry)).rejects.toThrow("escapes its directory");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a tree is bounded in entries, bytes, and depth so a read-back cannot be turned into a denial of service", async () => {
  const directory = await root();
  try {
    await writeFile(join(directory, "a.bin"), "12345");
    await writeFile(join(directory, "b.bin"), "12345");
    await expect(listRunnerMaterials(directory, { maxEntries: 1 })).rejects.toThrow("too many entries");
    await expect(listRunnerMaterials(directory, { maxTotalBytes: 6 })).rejects.toThrow("too large");
    await mkdir(join(directory, "one", "two"), { recursive: true });
    await writeFile(join(directory, "one", "two", "c.bin"), "x");
    await expect(listRunnerMaterials(directory, { maxDepth: 1 })).rejects.toThrow("nested too deeply");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an entry that is not a regular file is refused", async () => {
  const directory = await root();
  try {
    await Bun.$`mkfifo ${join(directory, "pipe")}`.quiet();
    await expect(listRunnerMaterials(directory)).rejects.toThrow("not a regular file");
    await expect(openRunnerMaterial(directory, "pipe")).rejects.toThrow(/not a regular file|could not be opened/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the material mount is read-write but carries the same posture the tmpfs does", () => {
  // The exact option string, because both W11 and W12 consume this one function
  // rather than writing their own, and a drifted option is a silent weakening.
  expect(runnerMaterialMount("/srv/materials/attempt-a")).toEqual([
    "--mount",
    `type=bind,src=/srv/materials/attempt-a,dst=${GUEST_MATERIALS_PATH},rw=true,relabel=private,noexec,nosuid,nodev`,
  ]);
  const options = runnerMaterialMount("/srv/materials/attempt-a")[1]!;
  // Writable, unlike /workspace and /channel, and that is the whole point.
  expect(options).toContain("rw=true");
  expect(options).not.toContain("ro=true");
  // Never executable, setuid, or a device node.
  for (const flag of ["noexec", "nosuid", "nodev"]) expect(options).toContain(flag);
  // A fixed path, never an environment variable.
  expect(GUEST_MATERIALS_PATH).toBe("/materials");
});

/** Reaches the private handover without loosening its visibility in production. */
class HandoverProbe extends PodmanRunner {
  handOver(directory: string): Promise<void> {
    return (this as unknown as { handOverMaterials(directory: string): Promise<void> }).handOverMaterials(directory);
  }
}

test("the handover refuses a directory it cannot vouch for, before touching podman", async () => {
  const store = await root();
  try {
    // The podman binary is deliberately a path that cannot execute. Every case
    // below must fail on its own check, so reaching podman at all would surface
    // as a spawn error instead of the typed refusal.
    const runner = new HandoverProbe({ root: store, podman: "/nonexistent/podman-must-never-run" });

    // Missing directory.
    const absent = join(store, "not-created");
    const missing = await runner.handOver(absent).then(() => undefined, (error: unknown) => error as { name?: string; code?: string; message?: string });
    expect(missing?.name).toBe("RunnerError");
    expect(missing?.code).toBe("material_directory_invalid");
    expect(missing?.message).toContain("does not exist");

    // A regular file where the directory should be.
    const asFile = join(store, "a-file");
    await writeFile(asFile, "not a directory");
    const file = await runner.handOver(asFile).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
    expect(file?.code).toBe("material_directory_invalid");
    expect(file?.message).toContain("is not a directory");

    // A symlink pointing at a perfectly good directory is still refused, because
    // the runner would otherwise chmod and chown whatever it resolves to.
    const target = join(store, "real-directory");
    await mkdir(target);
    const linked = join(store, "linked");
    await symlink(target, linked);
    const link = await runner.handOver(linked).then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
    expect(link?.code).toBe("material_directory_invalid");
    expect(link?.message).toContain("is not a directory");
    // The target it pointed at is untouched: no mode change reached it.
    expect((await lstat(target)).mode & 0o777).not.toBe(0o770);

    // A directory the runner does not own. `/` is owned by root on every host
    // this runs on, and the runner is never root.
    const foreign = await runner.handOver("/").then(() => undefined, (error: unknown) => error as { code?: string; message?: string });
    expect(foreign?.code).toBe("material_directory_invalid");
    expect(foreign?.message).toContain("is not owned by the runner");
    // And nothing about it changed.
    expect((await lstat("/")).uid).toBe(0);
  } finally { await rm(store, { recursive: true, force: true }); }
});
