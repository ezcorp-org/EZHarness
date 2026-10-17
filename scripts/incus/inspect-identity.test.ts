import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindProtectedSshIdentity, sshRunner } from "./inspect";

const connection = () => ({ sshTarget: "setup@example.invalid", sshIdentityFile: "/protected/key",
  sshKnownHostsFile: "/protected/hosts", sshHostKeySha256: `SHA256:${"a".repeat(43)}`,
  sshMode: "reviewed-envelope-v1" as const });

test("protected SSH identity rejects partial, extra, root, unsafe and malformed identities", () => {
  const uid = spyOn(process, "geteuid").mockReturnValue(0);
  try {
    for (const identity of [null, {}, { uid: 62040 }, { uid: 62040, gid: 62040, extra: true },
      { uid: 0, gid: 62040 }, { uid: 62040, gid: 0 }, { uid: "62040", gid: 62040 },
      { uid: Number.MAX_SAFE_INTEGER, gid: 62040 }, { uid: 62040, gid: Number.MAX_SAFE_INTEGER },
      { uid: 62040, gid: 1.1 }, { uid: 62040.1, gid: 62040 }]) {
      expect(() => bindProtectedSshIdentity(connection(), identity)).toThrow("execution identity");
    }
    uid.mockReturnValue(1001);
    expect(() => bindProtectedSshIdentity(connection(), { uid: 62040, gid: 62040 })).toThrow("execution identity");
  } finally { uid.mockRestore(); }
});

test("normal gate exercises protected wrapping and wrapper failure without privileged execution", async () => {
  const uid = spyOn(process, "geteuid").mockReturnValue(0);
  const original = childProcess.spawn;
  const calls: { command: string; args: string[] }[] = [];
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: childProcess.SpawnOptions) => {
    calls.push({ command, args: [...args] });
    return original("/run/current-system/sw/bin/false", [], options);
  }) as typeof childProcess.spawn);
  try {
    const identity = { uid: 62040, gid: 62040 };
    const bound = bindProtectedSshIdentity(connection(), identity);
    identity.uid = 0;
    expect((await sshRunner(bound)(["incus", "query", "/1.0"])).exitCode).not.toBe(0);
    expect((await sshRunner(connection())(["incus", "query", "/1.0"])).exitCode).not.toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("/run/current-system/sw/bin/setpriv");
    expect(calls[0]!.args.slice(0, 5)).toEqual(["--reuid=62040", "--regid=62040", "--clear-groups", "--", "/run/current-system/sw/bin/ssh"]);
    expect(calls[1]!.command).toBe("ssh");
    expect(calls[0]!.args.slice(5)).toEqual(calls[1]!.args);
  } finally { spawn.mockRestore(); uid.mockRestore(); }
});

test.skipIf(process.geteuid?.() !== 0)("real protected SSH child uses service identity and clears root groups", async () => {
  const root = mkdtempSync(join(tmpdir(), "incus-ssh-identity-"));
  chmodSync(root, 0o755);
  const fake = join(root, "ssh");
  writeFileSync(fake, '#!/run/current-system/sw/bin/python3\nimport os,json,sys\nprint(json.dumps({"uid":os.geteuid(),"gid":os.getegid(),"groups":os.getgroups(),"argv":sys.argv[1:],"stdin":sys.stdin.read()}))\n', { mode: 0o755 });
  const original = childProcess.spawn;
  const calls: { command: string; args: readonly string[] }[] = [];
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: childProcess.SpawnOptions) => {
    calls.push({ command, args: [...args] });
    if (command === "/run/current-system/sw/bin/setpriv") {
      expect(args.slice(0, 5)).toEqual(["--reuid=62040", "--regid=62040", "--clear-groups", "--", "/run/current-system/sw/bin/ssh"]);
      return original(command, [...args.slice(0, 4), fake, ...args.slice(5)], options);
    }
    expect(command).toBe("ssh");
    return original(fake, args, options);
  }) as typeof childProcess.spawn);
  try {
    const unbound = connection();
    const before = JSON.parse((await sshRunner(unbound)(["incus", "query", "/1.0"])).stdout);
    expect(before.uid).toBe(0);
    const bound = bindProtectedSshIdentity(connection(), { uid: 62040, gid: 62040 });
    const after = await sshRunner(bound)(["incus", "query", "/1.0"]);
    expect(after.exitCode).toBe(0);
    const actual = JSON.parse(after.stdout);
    expect({ uid: actual.uid, gid: actual.gid, groups: actual.groups }).toEqual({ uid: 62040, gid: 62040, groups: [] });
    expect(actual.argv).toEqual(before.argv);
    expect(actual.stdin).toBe(before.stdin);
    expect(calls.map(call => call.command)).toEqual(["ssh", "/run/current-system/sw/bin/setpriv"]);
  } finally { spawn.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.geteuid?.() !== 0)("failed protected credential wrapper never falls back to root SSH", async () => {
  const original = childProcess.spawn;
  for (const executable of ["/nonexistent-incus-setpriv-test", "/run/current-system/sw/bin/false"]) {
    const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, _args: string[], options: childProcess.SpawnOptions) => {
      expect(command).toBe("/run/current-system/sw/bin/setpriv");
      return original(executable, [], options);
    }) as typeof childProcess.spawn);
    try {
      const bound = bindProtectedSshIdentity(connection(), { uid: 62040, gid: 62040 });
      const result = await sshRunner(bound)(["incus", "query", "/1.0"]);
      expect(result.exitCode).not.toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { spawn.mockRestore(); }
  }
});
