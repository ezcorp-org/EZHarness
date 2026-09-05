import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../..");

async function launch(overrides: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "real-auth-launch-"));
  const record = join(directory, "commands.jsonl");
  const executable = join(directory, "bun");
  await writeFile(executable, `#!${process.execPath}
import { appendFile, writeFile } from "node:fs/promises";
await appendFile(process.env.LAUNCH_RECORD, JSON.stringify({args:process.argv.slice(2),port:process.env.PORT,host:process.env.HOST,socket:process.env.SOCKET_PATH,bodySize:process.env.BODY_SIZE_LIMIT,cwd:process.cwd()})+"\\n");
if(process.argv[2]==="-e" && process.argv[3].includes("randomBytes")) await writeFile(process.env.EZ_EXTENSION_RUNNER_TOKEN_FILE,"test-credential");
`);
  await chmod(executable, 0o700);
  try {
    const child = Bun.spawn(["bash", "scripts/start-real-extension-preview.sh"], {
      cwd: root,
      env: { ...process.env, ...overrides, PATH: `${directory}:${process.env.PATH}`, LAUNCH_RECORD: record },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    return (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      args: string[]; port?: string; host?: string; socket?: string; bodySize?: string; cwd: string;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("real-auth production adapter launch", () => {
  test("builds before the production entry and pins the selected loopback port", async () => {
    const calls = await launch({ EZCORP_PORT: "4193", PORT: "9999", HOST: "0.0.0.0", SOCKET_PATH: "/tmp/unwanted.sock", BODY_SIZE_LIMIT: "" });
    const build = calls.findIndex((call) => call.args.join(" ") === "run build");
    const start = calls.findIndex((call) => call.args.join(" ") === "build/index.js");
    expect(build).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(build);
    expect(calls[start]).toEqual({ args: ["build/index.js"], port: "4193", host: "127.0.0.1", bodySize: "134217728", cwd: join(root, "web") });
    expect(calls.some((call) => call.args.includes("packages/@ezcorp/extension-runner/src/main.ts"))).toBe(true);
    expect(calls.some((call) => call.args.some((argument) => argument.includes("readiness-probe")))).toBe(true);
    expect(calls.some((call) => call.args.some((argument) => argument.includes("vite")))).toBe(false);
  });

  test("uses the preview port default and retains an explicit body limit", async () => {
    const calls = await launch({ EZCORP_PORT: "", PORT: "9999", BODY_SIZE_LIMIT: "1048576" });
    expect(calls.find((call) => call.args.join(" ") === "build/index.js")).toMatchObject({ port: "4173", host: "127.0.0.1", bodySize: "1048576" });
  });
});
