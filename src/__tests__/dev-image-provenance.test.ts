import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const script = join(root, "scripts", "warn-dev-image-provenance.sh");
const sandbox = mkdtempSync(join(tmpdir(), "ezcorp-image-provenance-"));
const bin = join(sandbox, "bin");
mkdirSync(bin);
await Bun.write(join(bin, "git"), "#!/usr/bin/env sh\ncase \"$*\" in *status*) printf '%s' \"$EZ_TEST_CHECKOUT_DIRTY\" ;; *) printf '%s\\n' \"$EZ_TEST_CHECKOUT_COMMIT\" ;; esac\n");
chmodSync(join(bin, "git"), 0o755);

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function run(imageCommit: string, checkoutCommit: string, dirty = false) {
  const child = Bun.spawnSync({
    cmd: ["sh", script],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EZCORP_IMAGE_BUILD_COMMIT: imageCommit, EZ_TEST_CHECKOUT_COMMIT: checkoutCommit, EZ_TEST_CHECKOUT_DIRTY: dirty ? " M image-backed-file" : "", EZCORP_REPO_DIR: sandbox },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode, stderr: child.stderr.toString() };
}

test("dev image provenance warns only when the image and bind-mounted checkout differ", async () => {
  expect(await Bun.file(script).exists()).toBe(true);
  const commit = "a".repeat(40);
  expect(run(commit, commit)).toEqual({ exitCode: 0, stderr: "" });
  const result = run("b".repeat(40), commit);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Web source is bind-mounted");
  expect(result.stderr).toContain("image-backed dependencies and generated assets");
  expect(result.stderr).toContain(`EZCORP_BUILD_COMMIT=${commit} bun run podman up -d --build`);
  const unknown = run("unknown", commit);
  expect(unknown.stderr).toContain("provenance is unavailable");
  expect(unknown.stderr).not.toContain("differs from");
  const dirty = run(commit, commit, true);
  expect(dirty.stderr).toContain("uncommitted changes");
  expect(dirty.stderr).toContain("sanctioned dev-stack wrapper");
});

test("the dev compose build records a revision and runs the startup comparison", async () => {
  const compose = await Bun.file(join(root, "docker-compose.yml")).text();
  const dockerfile = await Bun.file(join(root, "Dockerfile.dev")).text();
  expect(compose).toContain("EZCORP_BUILD_COMMIT");
  expect(compose).toContain("sh /app/scripts/warn-dev-image-provenance.sh");
  expect(dockerfile).toContain("org.opencontainers.image.revision");
});
