import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFactoryTempPrivateRoot } from "../__tests__/helpers/factory-private-root";
import { privateComponentVerdict, privateDirectory, readPrivate, readPrivateBounded, writePrivateBoundedAtomic } from "./private-files";

// A fresh 0700 root under os.tmpdir(): owned by this user, below the root-owned sticky /tmp.
// That is the shape a hosted runner offers, where $HOME is an owned 0755 directory.
let root: string;

beforeAll(async () => {
  root = await makeFactoryTempPrivateRoot("factory-private-files-");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function freshDirectory(name: string, mode = 0o700): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { mode });
  await chmod(path, mode);
  return path;
}

async function privateFile(directory: string, name: string, content: string, mode = 0o600): Promise<void> {
  await writeFile(join(directory, name), content, { mode });
  await chmod(join(directory, name), mode);
}

async function readThrough(directory: string, name: string, maximum: number): Promise<string> {
  const handle = await privateDirectory(directory);
  try { return Buffer.from(await readPrivateBounded(handle, name, maximum)).toString("utf8"); }
  finally { await handle.close(); }
}

describe("privateDirectory", () => {
  test("opens an owned private directory under non-writable foreign ancestors", async () => {
    const directory = await freshDirectory("open-ok");
    const handle = await privateDirectory(directory);
    try { expect((await handle.stat()).isDirectory()).toBe(true); }
    finally { await handle.close(); }
  });

  test("refuses a path that never reaches a directory this user owns", async () => {
    await expect(privateDirectory("/")).rejects.toThrow("Private path has no owned directory.");
  });

  test("accepts the root-owned sticky temporary directory as an ancestor, and still needs an owned directory below it", async () => {
    const temporary = await stat(tmpdir());
    expect([temporary.uid, temporary.mode & 0o1777]).toEqual([0, 0o1777]);
    await expect(privateDirectory(tmpdir())).rejects.toThrow("Private path has no owned directory.");
    await (await privateDirectory(root)).close();
  });

  describe("the verdict on one component, for owners and modes a test cannot create", () => {
    const me = 1000;
    const above = { reachedOwnedDirectory: false, mayRepair: false };
    test("a root-owned sticky world-writable ancestor is accepted", () => {
      expect(privateComponentVerdict({ uid: 0, mode: 0o41777 }, me, above)).toBe("foreign");
    });
    test("a root-owned world-writable ancestor without the sticky bit is refused, and so is a group-writable one", () => {
      expect(() => privateComponentVerdict({ uid: 0, mode: 0o40777 }, me, above)).toThrow("Private path has a writable foreign ancestor.");
      expect(() => privateComponentVerdict({ uid: 0, mode: 0o40775 }, me, above)).toThrow("Private path has a writable foreign ancestor.");
    });
    test("a sticky world-writable ancestor owned by another user is refused", () => {
      expect(() => privateComponentVerdict({ uid: 1234, mode: 0o41777 }, me, above)).toThrow("Private path has a writable foreign ancestor.");
    });
    test("a root-owned sticky directory below the first owned directory is refused", () => {
      expect(() => privateComponentVerdict({ uid: 0, mode: 0o41777 }, me, { reachedOwnedDirectory: true, mayRepair: false })).toThrow("Private path has a writable foreign ancestor.");
    });
    test("an owned ancestor that is not 0700 is refused; only a repairable leaf may be repaired", () => {
      expect(() => privateComponentVerdict({ uid: me, mode: 0o40755 }, me, above)).toThrow("Private path has a non-private owned ancestor.");
      expect(privateComponentVerdict({ uid: me, mode: 0o40755 }, me, { reachedOwnedDirectory: true, mayRepair: true })).toBe("repair");
      expect(privateComponentVerdict({ uid: me, mode: 0o40700 }, me, above)).toBe("owned");
      expect(privateComponentVerdict({ uid: 0, mode: 0o40755 }, me, above)).toBe("foreign");
    });
  });

  test("refuses an owned ancestor that other users can read, and repairs only an owned leaf when asked", async () => {
    const open = await freshDirectory("group-readable", 0o750);
    const child = join(open, "child");
    await mkdir(child, { mode: 0o700 });
    await expect(privateDirectory(child)).rejects.toThrow("Private path has a non-private owned ancestor.");
    await expect(privateDirectory(child, { repairOwnedLeaf: true })).rejects.toThrow("Private path has a non-private owned ancestor.");
    await expect(privateDirectory(open)).rejects.toThrow("Private path has a non-private owned ancestor.");
    const handle = await privateDirectory(open, { repairOwnedLeaf: true });
    await handle.close();
    expect((await stat(open)).mode & 0o777).toBe(0o700);
  });

  test("refuses a symbolic-link component instead of following it", async () => {
    const target = await freshDirectory("link-target");
    const link = join(root, "link");
    await symlink(target, link);
    // O_DIRECTORY with O_NOFOLLOW reports a link as "not a directory".
    await expect(privateDirectory(link)).rejects.toMatchObject({ code: "ENOTDIR" });
    await (await privateDirectory(target)).close();
  });

  test("refuses a regular file used as a directory component", async () => {
    const directory = await freshDirectory("file-component");
    await privateFile(directory, "file", "x");
    await expect(privateDirectory(join(directory, "file"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  test("creates a missing leaf only below an owned directory and only when asked", async () => {
    const parent = await freshDirectory("create-leaf");
    const leaf = join(parent, "new");
    await expect(privateDirectory(leaf)).rejects.toMatchObject({ code: "ENOENT" });
    const handle = await privateDirectory(leaf, { createLeaf: true });
    await handle.close();
    expect((await stat(leaf)).mode & 0o777).toBe(0o700);
    await expect(privateDirectory("/factory-private-files-absent/leaf", { createLeaf: true })).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to run without a POSIX owner", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try { await expect(privateDirectory(root)).rejects.toThrow("Private files require a POSIX owner."); }
    finally { Object.defineProperty(process, "getuid", descriptor); }
  });
});

describe("readPrivateBounded and readPrivate", () => {
  test("read one owned private regular file within its bound", async () => {
    const directory = await freshDirectory("read-ok");
    await privateFile(directory, "value", "secret-ref");
    expect(await readThrough(directory, "value", 64)).toBe("secret-ref");
    const handle = await privateDirectory(directory);
    try { expect(Buffer.from(await readPrivate(handle, "value", 10)).toString("utf8")).toBe("secret-ref"); }
    finally { await handle.close(); }
  });

  test("refuse an exact-size read whose file has another length", async () => {
    const directory = await freshDirectory("read-exact");
    await privateFile(directory, "value", "12345");
    const handle = await privateDirectory(directory);
    try { await expect(readPrivate(handle, "value", 6)).rejects.toThrow("Private file must be exact-sized."); }
    finally { await handle.close(); }
  });

  test("refuse a leaf name with a path, or a bound that is not a positive integer", async () => {
    const directory = await freshDirectory("read-leaf");
    const handle = await privateDirectory(directory);
    try {
      for (const [name, maximum] of [["../value", 8], ["a/b", 8], ["value", 0], ["value", 1.5], ["value", Number.NaN]] as const) {
        await expect(readPrivateBounded(handle, name, maximum)).rejects.toThrow("Private file leaf is invalid.");
      }
    } finally { await handle.close(); }
  });

  test("refuse a file that is readable by others, empty, over its bound, or not regular", async () => {
    const directory = await freshDirectory("read-refusals");
    await privateFile(directory, "shared", "x", 0o640);
    await privateFile(directory, "empty", "");
    await privateFile(directory, "large", "123456789");
    await mkdir(join(directory, "folder"), { mode: 0o700 });
    for (const name of ["shared", "empty", "large", "folder"]) {
      await expect(readThrough(directory, name, 8)).rejects.toThrow("Private file must be owned, private, regular, and bounded.");
    }
  });

  test("refuse a symbolic-link leaf instead of following it", async () => {
    const directory = await freshDirectory("read-link");
    await privateFile(directory, "real", "x");
    await symlink(join(directory, "real"), join(directory, "alias"));
    await expect(readThrough(directory, "alias", 8)).rejects.toMatchObject({ code: "ELOOP" });
  });
});

describe("writePrivateBoundedAtomic", () => {
  test("creates the private leaf directory, writes a private file, and replaces it without leaving a temporary file", async () => {
    const parent = await freshDirectory("write-ok");
    const path = join(parent, "state", "value.json");
    await writePrivateBoundedAtomic(path, Buffer.from("first"), 64);
    await writePrivateBoundedAtomic(path, Buffer.from("second"), 64);
    expect((await stat(join(parent, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readThrough(join(parent, "state"), "value.json", 64)).toBe("second");
    expect(await readdir(join(parent, "state"))).toEqual(["value.json"]);
  });

  test("repairs an owned leaf directory that other users could read", async () => {
    const directory = await freshDirectory("write-repair", 0o755);
    await writePrivateBoundedAtomic(join(directory, "value"), Buffer.from("x"), 8);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  test("refuses output that is empty, over its bound, not bytes, or has no valid bound", async () => {
    const path = join(root, "write-invalid", "value");
    const cases: readonly [unknown, number][] = [[new Uint8Array(0), 8], [Buffer.from("123456789"), 8], ["text", 8], [Buffer.from("x"), 0], [Buffer.from("x"), 1.5]];
    for (const [bytes, maximum] of cases) {
      await expect(writePrivateBoundedAtomic(path, bytes as Uint8Array, maximum)).rejects.toThrow("Private file output is invalid.");
    }
  });

  test("refuses a path without a file leaf", async () => {
    await expect(writePrivateBoundedAtomic("/", Buffer.from("x"), 8)).rejects.toThrow("Private file leaf is invalid.");
  });

  test("reports a failed replacement, keeps the existing target, and removes its temporary file", async () => {
    const directory = await freshDirectory("write-fail");
    await mkdir(join(directory, "target"), { mode: 0o700 });
    await privateFile(join(directory, "target"), "inside", "kept");
    await expect(writePrivateBoundedAtomic(join(directory, "target"), Buffer.from("x"), 8)).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY|EEXIST)$/) });
    expect(await readdir(directory)).toEqual(["target"]);
    expect(await readThrough(join(directory, "target"), "inside", 8)).toBe("kept");
  });
});
