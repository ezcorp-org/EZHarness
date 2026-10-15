import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UV_RESOLUTION_ORDER, UvUnavailableError, resolveUvBinary, uvCommand } from "./uv-command";

const only = (...present: string[]) => (tool: string) => (present.includes(tool) ? `/bin/${tool}` : null);

describe("resolveUvBinary", () => {
  test("tries uv on PATH, then nix-shell, then nix, exactly like scripts/python-quality.sh", async () => {
    const script = await readFile(join(import.meta.dir, "../../../scripts/python-quality.sh"), "utf8");
    const block = /^if command -v uv [\s\S]*?^fi$/m.exec(script)?.[0] ?? "";
    const shellOrder = [...block.matchAll(/^(?:if|elif) command -v (\S+) /gm)].map((match) => match[1]);
    expect(shellOrder).toEqual([...UV_RESOLUTION_ORDER]);
  });

  test("uses uv on PATH as it is, even when nix is there too, and never runs a probe", () => {
    const probes: string[][] = [];
    expect(resolveUvBinary(only("uv", "nix-shell", "nix"), (command) => { probes.push([...command]); return ""; })).toBe("/bin/uv");
    expect(probes).toEqual([]);
  });

  test("falls back to nix-shell and takes the store path it names", () => {
    const probes: string[][] = [];
    const found = resolveUvBinary(only("nix-shell", "nix"), (command) => { probes.push([...command]); return "/nix/store/x-uv/bin/uv"; });
    expect(found).toBe("/nix/store/x-uv/bin/uv");
    expect(probes).toEqual([["/bin/nix-shell", "-p", "uv", "--run", "command -v uv"]]);
  });

  test("falls back to nix shell when only nix is present", () => {
    const probes: string[][] = [];
    expect(resolveUvBinary(only("nix"), (command) => { probes.push([...command]); return "/nix/store/y-uv/bin/uv"; })).toBe("/nix/store/y-uv/bin/uv");
    expect(probes).toEqual([["/bin/nix", "shell", "nixpkgs#uv", "-c", "sh", "-c", "command -v uv"]]);
  });

  test("refuses by name when a Nix tool cannot provide uv, or when nothing is present", () => {
    expect(() => resolveUvBinary(only("nix-shell"), () => "")).toThrow("nix-shell is on PATH but did not provide uv");
    expect(() => resolveUvBinary(only(), () => "/never")).toThrow(UvUnavailableError);
    expect(() => resolveUvBinary(only(), () => "/never")).toThrow("no 'uv' available; install uv or provide nix-shell. The Python lanes cannot be skipped.");
  });

  test("the default probe runs the Nix tool it found, takes the path it prints, and refuses when the tool fails", async () => {
    // A runner that installs uv on PATH (every hosted shard) never reaches the
    // probe, so a stand-in nix-shell drives the real spawn here: the binary
    // `which` found, with the exact arguments the resolver passes.
    const bin = await mkdtemp(join(tmpdir(), "uv-probe-"));
    const tool = join(bin, "nix-shell");
    try {
      await writeFile(tool, `#!/bin/sh\nprintf '%s|' "$@" > "${bin}/args"\necho '  /nix/store/probe-uv/bin/uv  '\necho 'noise' >&2\n`);
      await chmod(tool, 0o755);
      expect(resolveUvBinary((name) => (name === "nix-shell" ? tool : null))).toBe("/nix/store/probe-uv/bin/uv");
      expect(await readFile(join(bin, "args"), "utf8")).toBe("-p|uv|--run|command -v uv|");

      await writeFile(tool, "#!/bin/sh\necho /nix/store/never/bin/uv\nexit 3\n");
      expect(() => resolveUvBinary((name) => (name === "nix-shell" ? tool : null))).toThrow("nix-shell is on PATH but did not provide uv");
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  test("on this host the real resolution gives a runnable uv, reused for every command", () => {
    const first = uvCommand(["--version"]);
    expect(first[0]!.startsWith("/")).toBe(true);
    expect(first.slice(1)).toEqual(["--version"]);
    expect(uvCommand(["run"])[0]).toBe(first[0]);
    const run = Bun.spawnSync(first, { stdout: "pipe" });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toStartWith("uv ");
  });
});
