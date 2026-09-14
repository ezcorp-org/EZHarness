import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunnerMaterials, openRunnerMaterial } from "../src/materials";
import { GUEST_MATERIALS_PATH, runnerMaterialMount } from "../src/podman";

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
