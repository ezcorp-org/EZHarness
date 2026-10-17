import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * scripts/setup-factory-storage.sh end to end with a recording compose client: the generated identity files
 * hold exactly the requested tenant names (default: tenant-01 to tenant-10 under the shared project), and each
 * store seeds exactly those buckets. Credential values are read from the files only to prove they never reach
 * the script's output.
 */
const SCRIPT = resolve(import.meta.dir, "setup-factory-storage.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function run(env: Record<string, string>, action = "up", reuse?: string) {
  const root = reuse ?? mkdtempSync(join(tmpdir(), "setup-storage-test-")); if (!reuse) roots.push(root);
  const runtime = join(root, "runtime"); if (!existsSync(runtime)) { mkdirSync(runtime); chmodSync(runtime, 0o700); }
  const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  const calls = join(root, "calls");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\n[ "$1 $2" = "compose version" ] && exit 0\necho "project=$COMPOSE_PROJECT_NAME $*" >> ${calls}\ncase " $* " in *" exec "*) sed "s/^/stdin: /" >> ${calls};; esac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, "podman"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const result = Bun.spawnSync(["bash", SCRIPT, action], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, UID: String(process.getuid!()), XDG_RUNTIME_DIR: runtime, EZCORP_CONTAINER_ENGINE: "podman", DOCKER_HOST: "unix:///nonexistent.sock", ...env },
  });
  const [secrets] = readdirSync(runtime);
  const dir = secrets === undefined ? "" : join(runtime, secrets);
  const names = (domain: string) => dir ? (JSON.parse(readFileSync(join(dir, `${domain}.json`), "utf8")).identities as { name: string }[]).map((entry) => entry.name) : [];
  const out = `${result.stdout.toString()}${result.stderr.toString()}`;
  const keys = dir ? ["ordinary", "archive"].flatMap((domain) => (JSON.parse(readFileSync(join(dir, `${domain}.json`), "utf8")).identities as { credentials: { accessKey: string; secretKey: string }[] }[])
    .flatMap((entry) => [entry.credentials[0]!.accessKey, entry.credentials[0]!.secretKey])) : [];
  return { root, runtime, code: result.exitCode, secrets: secrets ?? "", dir, names, out, keys, calls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [], mode: dir ? statSync(join(dir, "ordinary.json")).mode & 0o777 : 0 };
}

describe("setup-factory-storage.sh", () => {
  test("by default it seeds tenant-01 to tenant-10 under the shared project, as before", () => {
    const r = run({});
    const ten = Array.from({ length: 10 }, (_, i) => `tenant-${String(i + 1).padStart(2, "0")}`);
    expect(r.code).toBe(0);
    expect(r.secrets).toStartWith("ezcorp-factory-storage.");
    expect(r.names("ordinary")).toEqual(ten);
    expect(r.names("archive")).toEqual(ten);
    expect(r.calls.filter((line) => line.startsWith("project=")).every((line) => line.startsWith(`project=ezcorp-factory-storage-${process.getuid!()} `))).toBe(true);
    expect(r.calls.filter((line) => line.startsWith("stdin: s3.bucket.create")).length).toBe(20);
    expect(r.mode).toBe(0o644);
    for (const key of r.keys) expect(r.out).not.toContain(key);
  });

  test("a project name and a tenant list seed exactly those tenants under that project (W4H-35 kind proof)", () => {
    const r = run({ EZCORP_FACTORY_STORAGE_PROJECT: "w4h35-stores", EZCORP_FACTORY_STORAGE_TENANTS: "01 35" });
    expect(r.code).toBe(0);
    expect(r.secrets).toStartWith("w4h35-stores.");
    expect(r.names("ordinary")).toEqual(["tenant-01", "tenant-35"]);
    expect(r.names("archive")).toEqual(["tenant-01", "tenant-35"]);
    const projects = new Set(r.calls.filter((line) => line.startsWith("project=")).map((line) => line.split(" ")[0]));
    expect([...projects]).toEqual(["project=w4h35-stores"]);
    expect(r.calls.filter((line) => line.startsWith("stdin: s3.bucket.create")).map((line) => line.slice(7))).toEqual([
      "s3.bucket.create -name=tenant-01", "s3.bucket.create -name=tenant-35", "s3.bucket.create -name=tenant-01", "s3.bucket.create -name=tenant-35",
    ]);
    for (const key of r.keys) expect(r.out).not.toContain(key);
  });

  test("down removes a named project's own pair and its credential directory (W4H-35 kind proof run 7)", () => {
    const env = { EZCORP_FACTORY_STORAGE_PROJECT: "w4h35-stores", EZCORP_FACTORY_STORAGE_TENANTS: "01 35" };
    const up = run(env);
    expect(up.code).toBe(0);
    const down = run({ ...env, EZCORP_FACTORY_STORAGE_SECRETS_DIR: up.dir }, "down", up.root);
    expect(down.out).toBe("");
    expect(down.code).toBe(0);
    expect(down.calls.filter((line) => line.includes(" down --volumes")).map((line) => line.split(" ")[0])).toEqual(["project=w4h35-stores"]);
    expect(existsSync(up.dir)).toBe(false);
  });

  test("a malformed project name or tenant id is refused before anything is written", () => {
    const malformed: Record<string, string>[] = [{ EZCORP_FACTORY_STORAGE_PROJECT: "Bad Name" }, { EZCORP_FACTORY_STORAGE_TENANTS: "35 x" }, { EZCORP_FACTORY_STORAGE_TENANTS: "" }, { EZCORP_FACTORY_STORAGE_TENANTS: "350" }];
    for (const env of malformed) {
      const r = run(env);
      expect(r.code).not.toBe(0);
      expect(r.secrets).toBe("");
    }
  });
});
