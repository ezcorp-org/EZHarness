import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const script = join(root, "scripts", "warn-dev-image-provenance.sh");
const sandbox = mkdtempSync(join(tmpdir(), "ezcorp-image-provenance-"));
const trackedInput = join(sandbox, "image-backed-source.txt");
const realGit = Bun.which("git") ?? "";
if (!realGit) throw new Error("git is required for provenance tests");
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => !key.startsWith("GIT_") && value !== undefined),
) as Record<string, string>;
const foreignGitDir = Bun.spawnSync({
  cmd: [realGit, "-C", root, "rev-parse", "--absolute-git-dir"],
  env: cleanEnv,
  stdout: "pipe",
}).stdout.toString().trim();

function git(...args: string[]): string {
  const result = Bun.spawnSync({ cmd: [realGit, "-C", sandbox, ...args], env: cleanEnv, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

writeFileSync(trackedInput, "clean source\n");
writeFileSync(join(sandbox, ".dockerignore"), ".git\n");
git("init", "-q");
git("add", ".");
git("-c", "user.name=Provenance test", "-c", "user.email=provenance@example.invalid", "commit", "-qm", "fixture");
const commit = git("rev-parse", "HEAD");

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function run(imageCommit: string, imageSourceState = "clean", repoDir = sandbox, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawnSync({
    cmd: ["sh", script],
    env: { ...cleanEnv, ...extraEnv, EZCORP_IMAGE_BUILD_COMMIT: imageCommit, EZCORP_IMAGE_BUILD_SOURCE_STATE: imageSourceState, EZCORP_REPO_DIR: repoDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode, stderr: child.stderr.toString() };
}

const dockerRebuildCommand = (revision: string) =>
  `Docker: EZCORP_BUILD_COMMIT=${revision} EZCORP_BUILD_SOURCE_STATE=$(bash scripts/resolve-dev-image-source-state.sh) docker compose up -d --build`;

test("dev image provenance warns only when the image and bind-mounted checkout differ", async () => {
  expect(await Bun.file(script).exists()).toBe(true);
  expect(run(commit)).toEqual({ exitCode: 0, stderr: "" });
  const result = run("b".repeat(40));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Web source is bind-mounted");
  expect(result.stderr).toContain("image-backed dependencies and generated assets");
  expect(result.stderr).toContain(dockerRebuildCommand(commit));
  expect(result.stderr).toContain("Rootless Podman: bun run podman up -d --build");
  const unknown = run("unknown");
  expect(unknown.stderr).toContain("provenance is unavailable");
  expect(unknown.stderr).not.toContain("differs from");
  expect(unknown.stderr).toContain(dockerRebuildCommand(commit));
  writeFileSync(trackedInput, "dirty source\n");
  try {
    const dirty = run(commit);
    expect(dirty.stderr).toContain("uncommitted Docker build-context changes");
    expect(dirty.stderr).toContain("Rebuild the image");
    expect(dirty.stderr).toContain(dockerRebuildCommand(commit));
  } finally {
    writeFileSync(trackedInput, "clean source\n");
  }
  expect(run(commit, "unknown").stderr).toContain("build source state is unavailable");
  const unreadable = run(commit, "clean", join(sandbox, "missing-checkout"));
  expect(unreadable.stderr).toContain("provenance was not compared");
  expect(unreadable.stderr).toContain(
    dockerRebuildCommand("unknown"),
  );
  expect(run(commit, "clean", sandbox, { TMPDIR: join(sandbox, "missing-tmp") }).stderr).toContain("revision comparison is incomplete");
});

test("a dirty image build still warns after the checkout becomes clean", () => {
  const result = run(commit, "dirty");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("image was built from uncommitted source changes");
  expect(result.stderr).toContain("image-backed dependencies and generated assets may not match");
  expect(result.stderr).toContain("Rootless Podman: bun run podman up -d --build");
});

test("provenance inspection ignores inherited Git repository and index overrides", () => {
  writeFileSync(trackedInput, "dirty source\n");
  try {
    const result = run(commit, "clean", sandbox, {
      GIT_DIR: foreignGitDir,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(sandbox, "alternate-index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.ignoreCase",
      GIT_CONFIG_VALUE_0: "true",
    });
    expect(result.stderr).toContain("uncommitted Docker build-context changes");
    expect(result.stderr).not.toContain("differs from /repo HEAD");
    expect(result.stderr).not.toContain("provenance was not compared");
    expect(git("config", "--bool", "core.bare")).toBe("false");
  } finally {
    writeFileSync(trackedInput, "clean source\n");
  }
});
