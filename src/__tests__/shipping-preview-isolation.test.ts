import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// scripts/verify-shipping-preview-isolation.sh runs the two in-image preview
// test files inside the candidate image under rootless Podman. A fake `podman`
// records its argv and prints the Bun report the case asks for, so these cases
// pin the argv (the uid map, the mount, the variable) and the zero-test refusal
// without an image.

const root = resolve(import.meta.dir, "../..");
const script = resolve(root, "scripts/verify-shipping-preview-isolation.sh");
const shell = Bun.which("bash") ?? (() => { throw new Error("bash is required for the preview isolation proof test"); })();
const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const PASSING = "src/__tests__/preview-uid-keystone.docker.test.ts:\n(pass) uid keystone — LIVE (production image) > helper refuses an out-of-range uid even invoked directly\n\n 7 pass\n 0 fail\nRan 7 tests across 2 files.\n";
const SKIPPED = "src/__tests__/preview-uid-keystone.docker.test.ts:\n(skip) uid keystone — LIVE (production image) > helper refuses an out-of-range uid even invoked directly\n\n 0 pass\n 7 skip\n 0 fail\nRan 7 tests across 2 files.\n";

async function run(report: string, podmanExit = 0, env: Record<string, string> = {}): Promise<{ code: number; output: string; argv: string; mount: { source: string; mode: string; files: string[] } }> {
  const directory = await mkdtemp(join(tmpdir(), "preview-isolation-proof-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(directory, "report.txt"), report);
  // The fake also records what the container would see at the mount: the staged folder's mode and its files' modes.
  await writeFile(join(bin, "podman"), [
    `#!${shell}`,
    `printf '%s\\n' "$@" > "${directory}/argv"`,
    `for a in "$@"; do case "$a" in --volume=*) v="\${a#--volume=}"; src="\${v%%:*}"; echo "$src" > "${directory}/mount-source"; stat -c '%a' "$src" > "${directory}/mount-mode"; (cd "$src" && stat -c '%a %n' *) > "${directory}/mount-files";; esac; done`,
    `cat "${directory}/report.txt"`,
    `exit ${podmanExit}`,
  ].join("\n") + "\n");
  await chmod(join(bin, "podman"), 0o700);
  const child = Bun.spawn({
    cmd: [shell, script],
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EZ_PRODUCTION_IMAGE: "ezcorp:test-candidate", EZ_PRODUCTION_RECEIPT_DIR: join(directory, "receipt"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const read = (name: string) => readFile(join(directory, name), "utf8").catch(() => "");
  return { code, output: `${stdout}${stderr}`, argv: await read("argv"), mount: { source: (await read("mount-source")).trim(), mode: (await read("mount-mode")).trim(), files: (await read("mount-files")).trim().split("\n") } };
}

test("runs the plan's preview files inside the candidate image with the preview uid range mapped and the lane variable set", async () => {
  const result = await run(PASSING);
  expect(result.code).toBe(0);
  expect(result.output).toContain("7 pass");
  const argv = result.argv.trim().split("\n");
  expect(argv.slice(0, 2)).toEqual(["run", "--rm"]);
  // Rootless Podman maps 65,536 subordinate ids: the image's low ids and the helper's 90000–99000 range, nothing else.
  for (const map of ["--uidmap=0:0:56536", "--uidmap=90000:56536:9001", "--gidmap=0:0:56536", "--gidmap=90000:56536:9001"]) expect(argv).toContain(map);
  expect(argv).toContain("--network=none");
  expect(argv).toContain("--env=EZCORP_PREVIEW_ISOLATION_PROOF=1");
  // The image ships no tests, and the image's bun user must be able to read them whatever the checkout's umask: the
  // plan's files are staged world-readable in a temporary folder (W4H-33: a 0700 worktree folder read as "no test
  // files" in the image), and the folder is gone after the run.
  expect(argv).toContain(`--volume=${result.mount.source}:/app/src/__tests__:ro`);
  expect(result.mount.source).not.toBe(`${root}/src/__tests__`);
  expect(result.mount.mode).toBe("755");
  expect(result.mount.files.sort()).toEqual(["644 preview-dynamic-e2e.docker.test.ts", "644 preview-uid-keystone.docker.test.ts"]);
  expect(existsSync(result.mount.source)).toBe(false);
  expect(argv).toContain("--entrypoint=bun");
  const image = argv.indexOf("ezcorp:test-candidate");
  expect(argv.slice(image + 1)).toEqual(["test", "--timeout", "60000", "./src/__tests__/preview-uid-keystone.docker.test.ts", "./src/__tests__/preview-dynamic-e2e.docker.test.ts"]);
});

test("a run where the in-image tests skipped, failed or ran nothing is a failed proof", async () => {
  const skipped = await run(SKIPPED);
  expect(skipped.code).toBe(1);
  expect(skipped.output).toContain("preview-isolation: the in-image tests did not all run and pass");
  const failed = await run(PASSING.replace(" 0 fail", " 1 fail"), 1);
  expect(failed.code).toBe(1);
  const nothing = await run("Ran 0 tests across 0 files.\n");
  expect(nothing.code).toBe(1);
  expect(nothing.output).toContain("did not all run and pass");
});

test("refuses to start without the candidate image or a receipt directory", async () => {
  const noImage = await run(PASSING, 0, { EZ_PRODUCTION_IMAGE: "" });
  expect(noImage.code).not.toBe(0);
  expect(noImage.output).toContain("EZ_PRODUCTION_IMAGE");
  expect(noImage.argv).toBe("");
  const noReceipt = await run(PASSING, 0, { EZ_PRODUCTION_RECEIPT_DIR: "" });
  expect(noReceipt.code).not.toBe(0);
  expect(noReceipt.output).toContain("EZ_PRODUCTION_RECEIPT_DIR");
});
