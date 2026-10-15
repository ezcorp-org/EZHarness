import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import {
  FACTORY_PROVISIONED_FILE_LIMIT,
  ensureFactoryPrivateFile,
  factoryPrivatePath,
  openFactoryPrivateDirectory,
  readFactoryPrivateBytes,
  readFactoryPrivateJson,
  readFactoryPrivatePath,
  readFactoryPrivateText,
  removeFactoryPrivateDirectory,
  removeFactoryPrivateFile,
  replaceFactoryPrivateFile,
} from "./secret-files";
import { FactoryProvisioningError } from "./steps";

let root: string;
let directory: FileHandle | undefined;

beforeEach(async () => { root = await makeFactoryPrivateRoot(); });
afterEach(async () => {
  await directory?.close();
  directory = undefined;
  await removeFactoryPrivateRoot(root);
});

async function open(path = join(root, "secrets")): Promise<FileHandle> {
  directory = await openFactoryPrivateDirectory(path);
  return directory;
}

async function rejection(work: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await work; }
  catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected a rejection");
}

const INVALID_LEAVES = ["", ".", "..", "a/b", "../escape", "dir/"];

describe("openFactoryPrivateDirectory", () => {
  test("creates a missing leaf with mode 0700", async () => {
    await open(join(root, "fresh"));
    expect((await stat(join(root, "fresh"))).mode & 0o777).toBe(0o700);
  });

  test("repairs an owned leaf that is not private", async () => {
    await mkdir(join(root, "loose"));
    await chmod(join(root, "loose"), 0o755);
    await open(join(root, "loose"));
    expect((await stat(join(root, "loose"))).mode & 0o777).toBe(0o700);
  });

  test("refuses a non-private owned ancestor", async () => {
    await mkdir(join(root, "loose"));
    await chmod(join(root, "loose"), 0o755);
    expect((await rejection(openFactoryPrivateDirectory(join(root, "loose", "leaf")))).message).toBe("Private path has a non-private owned ancestor.");
  });
});

describe("ensureFactoryPrivateFile", () => {
  test("creates the file once as 0600 and reports it created", async () => {
    const handle = await open();
    let calls = 0;
    expect(await ensureFactoryPrivateFile(handle, "password", () => { calls += 1; return "first"; })).toBe(true);
    expect(await ensureFactoryPrivateFile(handle, "password", () => { calls += 1; return "second"; })).toBe(false);
    expect(calls).toBe(1);
    expect(await readFile(join(root, "secrets", "password"), "utf8")).toBe("first");
    expect((await stat(join(root, "secrets", "password"))).mode & 0o777).toBe(0o600);
  });

  test("accepts bytes as the value", async () => {
    const handle = await open();
    expect(await ensureFactoryPrivateFile(handle, "key.bin", () => new Uint8Array([1, 2, 3]))).toBe(true);
    expect([...await readFactoryPrivateBytes(handle, "key.bin")]).toEqual([1, 2, 3]);
  });

  test("refuses an existing file that is readable by others and leaves it unchanged", async () => {
    const handle = await open();
    await writeModeFile(join(root, "secrets", "password"), "old", 0o644);
    const error = await rejection(ensureFactoryPrivateFile(handle, "password", () => "new"));
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    expect((error as FactoryProvisioningError).code).toBe("provisioning_secret_unsafe");
    expect(error.message).toContain("password");
    expect(await readFile(join(root, "secrets", "password"), "utf8")).toBe("old");
  });

  test("refuses an existing entry that is not a regular file", async () => {
    const handle = await open();
    await mkdir(join(root, "secrets", "nested"), { mode: 0o700 });
    expect(((await rejection(ensureFactoryPrivateFile(handle, "nested", () => "x"))) as FactoryProvisioningError).code).toBe("provisioning_secret_unsafe");
  });

  test("does not follow a symlink and propagates the open error", async () => {
    const handle = await open();
    await writeModeFile(join(root, "target"), "outside");
    await symlink(join(root, "target"), join(root, "secrets", "link"));
    expect((await rejection(ensureFactoryPrivateFile(handle, "link", () => "x"))).code).toBe("ELOOP");
    expect(await readFile(join(root, "target"), "utf8")).toBe("outside");
  });

  test("refuses invalid leaf names before touching the file system", async () => {
    const handle = await open();
    for (const name of INVALID_LEAVES) {
      expect(((await rejection(ensureFactoryPrivateFile(handle, name, () => "x"))) as FactoryProvisioningError).code).toBe("provisioning_secret_leaf_invalid");
    }
  });

  test("concurrent first writes create exactly one file with the winner's value", async () => {
    const handle = await open();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => ensureFactoryPrivateFile(handle, "race", () => `value-${index}`)));
    const created = results.filter((result) => result.status === "fulfilled" && result.value === true);
    expect(created).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
    expect(await readFile(join(root, "secrets", "race"), "utf8")).toMatch(/^value-[0-7]$/);
  });
});

describe("private readers", () => {
  test("read bytes, text, and JSON through the private reader", async () => {
    const handle = await open();
    await ensureFactoryPrivateFile(handle, "data.json", () => JSON.stringify({ a: 1, b: ["x"] }));
    expect(await readFactoryPrivateText(handle, "data.json")).toBe('{"a":1,"b":["x"]}');
    expect(await readFactoryPrivateJson<{ a: number; b: string[] }>(handle, "data.json")).toEqual({ a: 1, b: ["x"] });
    expect((await readFactoryPrivateBytes(handle, "data.json")).byteLength).toBe(17);
  });

  test("enforce the byte limit", async () => {
    const handle = await open();
    await ensureFactoryPrivateFile(handle, "big", () => "12345");
    expect(await readFactoryPrivateText(handle, "big", 5)).toBe("12345");
    expect((await rejection(readFactoryPrivateText(handle, "big", 4))).message).toBe("Private file must be owned, private, regular, and bounded.");
  });

  test("the default limit is 64 KiB", async () => {
    const handle = await open();
    await ensureFactoryPrivateFile(handle, "max", () => "a".repeat(FACTORY_PROVISIONED_FILE_LIMIT));
    await ensureFactoryPrivateFile(handle, "over", () => "a".repeat(FACTORY_PROVISIONED_FILE_LIMIT + 1));
    expect((await readFactoryPrivateBytes(handle, "max")).byteLength).toBe(65_536);
    expect((await rejection(readFactoryPrivateBytes(handle, "over"))).message).toContain("bounded");
  });

  test("refuse a readable-by-others file", async () => {
    const handle = await open();
    await writeModeFile(join(root, "secrets", "loose"), "x", 0o640);
    expect((await rejection(readFactoryPrivateText(handle, "loose"))).message).toContain("private");
  });

  test("text refuses invalid UTF-8 and JSON rethrows that non-syntax failure", async () => {
    const handle = await open();
    await ensureFactoryPrivateFile(handle, "bad-utf8", () => new Uint8Array([0xff, 0xfe]));
    expect(await rejection(readFactoryPrivateText(handle, "bad-utf8"))).toBeInstanceOf(TypeError);
    expect(await rejection(readFactoryPrivateJson(handle, "bad-utf8"))).toBeInstanceOf(TypeError);
  });

  test("JSON maps a syntax error to provisioning_secret_corrupt without echoing content", async () => {
    const handle = await open();
    await ensureFactoryPrivateFile(handle, "corrupt.json", () => "{secret-value");
    const error = await rejection(readFactoryPrivateJson(handle, "corrupt.json"));
    expect((error as FactoryProvisioningError).code).toBe("provisioning_secret_corrupt");
    expect(error.message).not.toContain("secret-value");
  });

  test("JSON rethrows a missing file unchanged", async () => {
    const handle = await open();
    expect((await rejection(readFactoryPrivateJson(handle, "absent.json"))).code).toBe("ENOENT");
  });

  test("readers refuse invalid leaves", async () => {
    const handle = await open();
    for (const name of INVALID_LEAVES) expect(((await rejection(readFactoryPrivateBytes(handle, name))) as FactoryProvisioningError).code).toBe("provisioning_secret_leaf_invalid");
  });
});

describe("readFactoryPrivatePath", () => {
  test("reads by absolute path, and by a path that resolves to it", async () => {
    await open();
    await writeModeFile(join(root, "secrets", "token"), "abc");
    expect(new TextDecoder().decode(await readFactoryPrivatePath(join(root, "secrets", "token")))).toBe("abc");
    expect(new TextDecoder().decode(await readFactoryPrivatePath(join(root, "secrets", ".", "..", "secrets", "token"), 3))).toBe("abc");
  });

  test("refuses a missing file, an over-limit file, and a non-private directory", async () => {
    await open();
    await writeModeFile(join(root, "secrets", "token"), "abcd");
    expect((await rejection(readFactoryPrivatePath(join(root, "secrets", "missing")))).code).toBe("ENOENT");
    expect((await rejection(readFactoryPrivatePath(join(root, "secrets", "token"), 3))).message).toContain("bounded");
    await chmod(join(root, "secrets"), 0o750);
    expect((await rejection(readFactoryPrivatePath(join(root, "secrets", "token")))).message).toBe("Private path has a non-private owned ancestor.");
  });
});

describe("replaceFactoryPrivateFile", () => {
  test("creates the directory and file, then replaces it atomically", async () => {
    const path = join(root, "rotating", "credential");
    await replaceFactoryPrivateFile(path, "v1");
    expect(await readFile(path, "utf8")).toBe("v1");
    await replaceFactoryPrivateFile(path, new TextEncoder().encode("v2"));
    expect(await readFile(path, "utf8")).toBe("v2");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, "rotating"))).toEqual(["credential"]);
  });

  test("refuses an empty value and an over-limit value", async () => {
    expect((await rejection(replaceFactoryPrivateFile(join(root, "x"), ""))).message).toBe("Private file output is invalid.");
    expect((await rejection(replaceFactoryPrivateFile(join(root, "x"), "a".repeat(FACTORY_PROVISIONED_FILE_LIMIT + 1)))).message).toBe("Private file output is invalid.");
  });

  test("concurrent replacements leave one complete value and no temporary files", async () => {
    const path = join(root, "concurrent", "credential");
    const values = Array.from({ length: 10 }, (_, index) => `value-${index}-${"x".repeat(1_000)}`);
    await Promise.all(values.map((value) => replaceFactoryPrivateFile(path, value)));
    expect(values).toContain(await readFile(path, "utf8"));
    expect(await readdir(join(root, "concurrent"))).toEqual(["credential"]);
  });
});

describe("removeFactoryPrivateFile", () => {
  test("removes a file and succeeds again when it is already absent", async () => {
    const handle = await open();
    await ensureFactoryPrivateFile(handle, "gone", () => "x");
    await removeFactoryPrivateFile(handle, "gone");
    await removeFactoryPrivateFile(handle, "gone");
    expect(await readdir(join(root, "secrets"))).toEqual([]);
  });

  test("propagates a failure other than absence", async () => {
    const handle = await open();
    await mkdir(join(root, "secrets", "subdir"), { mode: 0o700 });
    expect(["EISDIR", "EPERM"]).toContain((await rejection(removeFactoryPrivateFile(handle, "subdir"))).code!);
    expect(await readdir(join(root, "secrets"))).toEqual(["subdir"]);
  });

  test("refuses invalid leaves", async () => {
    const handle = await open();
    for (const name of INVALID_LEAVES) expect(((await rejection(removeFactoryPrivateFile(handle, name))) as FactoryProvisioningError).code).toBe("provisioning_secret_leaf_invalid");
  });
});

describe("removeFactoryPrivateDirectory", () => {
  test("removes a private tree and is idempotent", async () => {
    const handle = await open();
    await ensureFactoryPrivateFile(handle, "a", () => "x");
    await directory!.close();
    directory = undefined;
    await removeFactoryPrivateDirectory(join(root, "secrets"));
    await removeFactoryPrivateDirectory(join(root, "secrets"));
    expect(await readdir(root)).toEqual([]);
  });

  test("refuses to delete a directory that is not private and leaves it in place", async () => {
    await mkdir(join(root, "shared"));
    await chmod(join(root, "shared"), 0o755);
    await writeFile(join(root, "shared", "keep"), "k");
    expect((await rejection(removeFactoryPrivateDirectory(join(root, "shared")))).message).toBe("Private path has a non-private owned ancestor.");
    expect(await readFile(join(root, "shared", "keep"), "utf8")).toBe("k");
  });
});

describe("factoryPrivatePath", () => {
  test("joins a resolved directory and a valid leaf", () => {
    expect(factoryPrivatePath("/srv/secrets/../secrets/tenant-01/", "file.json")).toBe("/srv/secrets/tenant-01/file.json");
  });

  test("refuses an invalid leaf", () => {
    for (const name of INVALID_LEAVES) {
      try { factoryPrivatePath("/srv", name); throw new Error("expected a refusal"); }
      catch (error) { expect((error as FactoryProvisioningError).code).toBe("provisioning_secret_leaf_invalid"); }
    }
  });
});
