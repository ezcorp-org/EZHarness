import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilitySet } from "../../extensions/capability-types";
import { DEFAULT_SETTINGS, FileOrganizerDaemon } from "../../extensions/file-organizer-daemon";
import type { AuthorizeContext, PermissionEngine } from "../../extensions/permission-engine";

type Phase = "copy-done" | "unlink-pending" | "copy-pending";
type EngineOutcome = "allow" | "deny" | "prompt" | "error";
type AuthorizationCall = { context: AuthorizeContext; needed: CapabilitySet };

const INSTALLATION_ID = "file-organizer-installation";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function recordingEngine(outcome: EngineOutcome, calls: AuthorizationCall[]): PermissionEngine {
  return {
    authorize: async (context: AuthorizeContext, needed: CapabilitySet) => {
      calls.push({ context, needed });
      if (outcome === "error") throw new Error("permission service unavailable");
      if (outcome === "deny") return { decision: "deny", reason: "revoked", auditId: "journal-deny" };
      if (outcome === "prompt") {
        return { decision: "prompt", sensitive: needed[0]!, auditId: "journal-prompt" };
      }
      return { decision: "allow", auditId: "journal-allow" };
    },
  } as PermissionEngine;
}

async function fixture(phase: Phase, outcome: EngineOutcome) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fo-journal-authority-")));
  roots.push(root);
  const dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  const watched = join(root, "watched");
  const source = join(watched, "victim.txt");
  const destination = join(watched, "done", "victim.txt");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  await mkdir(join(watched, "done"), { recursive: true });
  await writeFile(source, "owned source");
  await writeFile(destination, phase === "copy-pending" ? "partial destination" : "complete destination");
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ folders: [{ path: watched }] }));
  await writeFile(join(dataDir, "journal.json"), JSON.stringify([
    { op: "move", src: source, dst: destination, quarantineId: null, phase },
  ]));
  const calls: AuthorizationCall[] = [];
  const daemon = new FileOrganizerDaemon({
    dataDir,
    engine: recordingEngine(outcome, calls),
    extensionId: INSTALLATION_ID,
    getSettings: async () => DEFAULT_SETTINGS,
    skipLockfile: true,
  });
  return { calls, daemon, destination, source };
}

for (const phase of ["copy-done", "unlink-pending", "copy-pending"] as const) {
  for (const outcome of ["allow", "deny", "prompt", "error"] as const) {
    test(`startup replay ${phase}: ${outcome} authority`, async () => {
      const { calls, daemon, destination, source } = await fixture(phase, outcome);
      const mutationTarget = phase === "copy-pending" ? destination : source;
      try {
        expect(await daemon.start(DEFAULT_SETTINGS)).toBe(true);
        expect(calls).toEqual([{
          context: { extensionId: INSTALLATION_ID, userId: null, conversationId: null },
          needed: [{ kind: "fs.write", value: mutationTarget }],
        }]);

        if (outcome === "allow") {
          expect(await Bun.file(source).exists()).toBe(phase === "copy-pending");
          expect(await Bun.file(destination).exists()).toBe(phase !== "copy-pending");
        } else {
          expect(await readFile(source, "utf8")).toBe("owned source");
          expect(await readFile(destination, "utf8")).toBe(
            phase === "copy-pending" ? "partial destination" : "complete destination",
          );
        }
      } finally {
        daemon.stop();
      }
    });
  }
}
