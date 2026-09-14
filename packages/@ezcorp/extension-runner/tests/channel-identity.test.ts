import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PodmanRunner, runnerChannelMount } from "../src/podman";

/** Reaches the private channel helpers without loosening their visibility in production. */
class ChannelProbe extends PodmanRunner {
  facts(id: string): string { return (this as unknown as { channelFactsPath(id: string): string }).channelFactsPath(id); }
  directory(id: string): string { return (this as unknown as { channelDirectory(id: string): string }).channelDirectory(id); }
  entry(id: string, fifo: string, flags: number): Promise<{ close(): Promise<void> }> {
    return (this as unknown as { openChannelEntry(id: string, fifo: string, flags: number): Promise<{ close(): Promise<void> }> }).openChannelEntry(id, fifo, flags);
  }
}

async function probe(): Promise<{ runner: ChannelProbe; root: string; id: string }> {
  const root = await mkdtemp(join(tmpdir(), "ez-channel-identity-"));
  return { runner: new ChannelProbe({ root }), root, id: `worker-${randomUUID()}` };
}

test("the channel mount is read-only and names the private per-attempt directory", () => {
  expect(runnerChannelMount("/srv/channels/abc")).toEqual(["--mount", "type=bind,src=/srv/channels/abc,dst=/channel,ro=true,relabel=private"]);
  expect(runnerChannelMount("/srv/channels/abc").join(" ")).not.toContain("ro=false");
});

test("opening a channel entry refuses a replaced inode, a regular file, and a symlink", async () => {
  const { runner, root, id } = await probe();
  try {
    const directory = runner.directory(id);
    await Bun.$`mkdir -p ${directory}`.quiet();
    await chmod(directory, 0o755);
    await Bun.$`mkfifo -m 666 ${join(directory, "in")}`.quiet();
    const created = await lstat(join(directory, "in"));
    await writeFile(runner.facts(id), JSON.stringify({ in: { device: created.dev, inode: created.ino } }), { mode: 0o600 });

    // The honest entry opens.
    const handle = await runner.entry(id, "in", 2);
    await handle.close();

    // An inode that is not the one recorded at creation is refused. Recreating
    // the FIFO in place can reuse its inode number, so the comparison itself is
    // what this exercises.
    await writeFile(runner.facts(id), JSON.stringify({ in: { device: created.dev, inode: created.ino + 1 } }), { mode: 0o600 });
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("not the FIFO the runner created");
    await writeFile(runner.facts(id), JSON.stringify({ in: { device: created.dev + 1, inode: created.ino } }), { mode: 0o600 });
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("not the FIFO the runner created");
    await writeFile(runner.facts(id), JSON.stringify({ in: { device: created.dev, inode: created.ino } }), { mode: 0o600 });

    // A regular file is refused by the type check.
    await unlink(join(directory, "in"));
    await writeFile(join(directory, "in"), "not a fifo");
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("not the FIFO the runner created");

    // A symlink is refused at open time, before anything is dereferenced, and
    // surfaces as the same typed error rather than a raw ELOOP.
    await unlink(join(directory, "in"));
    await symlink("/etc/passwd", join(directory, "in"));
    await expect(runner.entry(id, "in", 2)).rejects.toMatchObject({ name: "RunnerError", code: "channel_untrusted" });
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("ELOOP");
    expect(await readFile("/etc/passwd", "utf8")).not.toBe("");

    // A directory in place of the FIFO is refused the same way, as EISDIR.
    await unlink(join(directory, "in"));
    await mkdir(join(directory, "in"));
    await expect(runner.entry(id, "in", 2)).rejects.toMatchObject({ name: "RunnerError", code: "channel_untrusted" });
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("EISDIR");

    // An absent entry is refused the same way, as ENOENT.
    await rm(join(directory, "in"), { recursive: true, force: true });
    await expect(runner.entry(id, "in", 2)).rejects.toMatchObject({ name: "RunnerError", code: "channel_untrusted" });
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a channel with no recorded identity, or an incomplete one, fails closed", async () => {
  const { runner, root, id } = await probe();
  try {
    const directory = runner.directory(id);
    await Bun.$`mkdir -p ${directory}`.quiet();
    await Bun.$`mkfifo -m 666 ${join(directory, "in")}`.quiet();
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("no recorded identity");

    await writeFile(runner.facts(id), JSON.stringify({ in: { device: 1.5, inode: 2 } }), { mode: 0o600 });
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("identity is incomplete");

    await writeFile(runner.facts(id), JSON.stringify({ out: { device: 1, inode: 2 } }), { mode: 0o600 });
    await expect(runner.entry(id, "in", 2)).rejects.toThrow("identity is incomplete");
  } finally { await rm(root, { recursive: true, force: true }); }
});
