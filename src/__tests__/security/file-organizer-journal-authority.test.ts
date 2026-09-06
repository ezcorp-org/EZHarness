import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, FileOrganizerDaemon } from "../../extensions/file-organizer-daemon";
import type { PermissionEngine } from "../../extensions/permission-engine";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function engine(decision: "allow" | "deny"): PermissionEngine {
  return {
    authorize: async () =>
      decision === "allow"
        ? { decision: "allow", auditId: "journal-allow" }
        : { decision: "deny", reason: "revoked", auditId: "journal-deny" },
  } as PermissionEngine;
}

async function fixture(decision: "allow" | "deny") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fo-journal-authority-")));
  roots.push(root);
  const dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  const watched = join(root, "watched");
  const victim = join(watched, "victim.txt");
  const destination = join(watched, "done", "victim.txt");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  await mkdir(join(watched, "done"), { recursive: true });
  await writeFile(victim, "owned victim");
  await writeFile(destination, "owned victim");
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ folders: [{ path: watched }] }));
  await writeFile(join(dataDir, "journal.json"), JSON.stringify([
    { op: "move", src: victim, dst: destination, quarantineId: null, phase: "copy-done" },
  ]));
  const daemon = new FileOrganizerDaemon({
    dataDir,
    engine: engine(decision),
    extensionId: "file-organizer-installation",
    getSettings: async () => DEFAULT_SETTINGS,
    skipLockfile: true,
  });
  return { daemon, victim };
}

test("startup replay preserves an in-anchor source when filesystem authority is denied", async () => {
  const { daemon, victim } = await fixture("deny");
  try {
    expect(await daemon.start(DEFAULT_SETTINGS)).toBe(true);
    expect(await readFile(victim, "utf8")).toBe("owned victim");
  } finally {
    daemon.stop();
  }
});

test("startup replay completes the same recovery when filesystem authority is allowed", async () => {
  const { daemon, victim } = await fixture("allow");
  try {
    expect(await daemon.start(DEFAULT_SETTINGS)).toBe(true);
    expect(await Bun.file(victim).exists()).toBe(false);
  } finally {
    daemon.stop();
  }
});
