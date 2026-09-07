import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WRAPPER = join(REPO_ROOT, "web", "e2e", "run-real-auth-fixture.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "real-auth-fixture-test-"));
  roots.push(root);
  return root;
}

function runFixture(root: string, command: string, env: Record<string, string> = {}) {
  const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root };
  delete environment.PI_E2E_REAL_DB_PATH;
  Object.assign(environment, env);
  return Bun.spawnSync(["bash", WRAPPER, "bash", "-c", command], {
    cwd: REPO_ROOT,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function fixtureRoots(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("ezcorp-e2e-"))
    .map(entry => join(root, entry.name));
}

describe("real-auth fixture root cleanup", () => {
  test("removes its default DB and encryption-key root after the preview command exits", () => {
    const root = tempRoot();
    const result = join(root, "result.txt");
    const proc = runFixture(root, 'mkdir -p "$EZCORP_DB_PATH"; printf database > "$EZCORP_DB_PATH/live"; printf key > "$EZCORP_SECRETS_DIR/key"; printf "%s\\n%s\\n" "$EZCORP_DB_PATH" "$EZCORP_SECRETS_DIR" > "$RESULT_PATH"', {
      RESULT_PATH: result,
    });

    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const [dbPath, secretsPath] = readFileSync(result, "utf8").trim().split("\n");
    expect(dbPath).toMatch(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/ezcorp-e2e-[^/]+/pglite$`));
    expect(secretsPath).toBe(`${dbPath!.slice(0, -"pglite".length)}secrets`);
    expect(existsSync(dbPath!)).toBe(false);
    expect(existsSync(secretsPath!)).toBe(false);
    expect(fixtureRoots(root)).toEqual([]);
  });

  test("preserves a caller-supplied database path", () => {
    const root = tempRoot();
    const external = join(root, "ezcorp-e2e-caller-database");
    const result = join(root, "result.txt");
    mkdirSync(external);
    writeFileSync(join(external, "keep"), "caller-owned");

    const proc = runFixture(root, 'printf "%s" "$EZCORP_DB_PATH" > "$RESULT_PATH"', {
      PI_E2E_REAL_DB_PATH: external,
      RESULT_PATH: result,
    });

    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(readFileSync(result, "utf8")).toBe(external);
    expect(readFileSync(join(external, "keep"), "utf8")).toBe("caller-owned");
    expect(fixtureRoots(root)).toEqual([external]);
  });

  test("refuses a tampered owned marker instead of deleting the root", () => {
    const root = tempRoot();
    const proc = runFixture(root, 'printf tampered > "$(dirname "$EZCORP_DB_PATH")/.ezcorp-real-auth-fixture"');

    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("ownership validation failed");
    expect(fixtureRoots(root)).toHaveLength(1);
  });

  test("keeps the preview failure visible after it cleans its owned root", () => {
    const root = tempRoot();
    const proc = runFixture(root, "exit 17");

    expect(proc.exitCode).toBe(17);
    expect(fixtureRoots(root)).toEqual([]);
  });
});
