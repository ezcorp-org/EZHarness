/**
 * e2e lane-manifest meta-test (wave 3, CI audit item 3.4).
 *
 * web/e2e/lanes.json assigns EVERY web/e2e/**\/*.spec.ts to exactly one
 * lane. This test keeps the manifest honest against the tree and against
 * ci.yml:
 *   - exhaustive: every on-disk spec appears in exactly ONE lane; no
 *     phantom entries for deleted specs.
 *   - marker consistency per lane (real-auth = the real config's testDir;
 *     evidence-soft members carry @evidence; docker members are
 *     DOCKER_TEST-gated; no @evidence spec hides in `unwired`).
 *   - the blocking mock-gate list has ONE home: ci.yml derives its
 *     playwright args via scripts/e2e-lane-args.ts (anchored regexes) —
 *     asserted both at the generator level and as an invocation anchor in
 *     ci.yml itself.
 *   - `unwired` is an honest, SHRINK-ONLY backlog, pinned to its EXACT
 *     current size: wiring a spec means moving it to a real lane and
 *     lowering the ceiling, never deleting the entry.
 *
 * Runs in the P∩C sweep (src/__tests__ → the CI cov-shards gate it).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { laneArgs } from "../../scripts/e2e-lane-args.ts";
import lanesManifest from "../../web/e2e/lanes.json";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LANE_NAMES = ["mock-gate", "real-auth", "evidence-soft", "docker", "unwired"] as const;

// Landing-time size of the unwired backlog — shrink-only ratchet.
// Unchanged (241) across the origin/main merge (fdca3a4f): main's Workflows
// rename replaced pipelines{,-new,-actions}.spec.ts with the equivalent
// workflows-* specs, still unwired there (no @evidence, no DOCKER_TEST, in
// no CI job) — net backlog 241. Wiring a spec means MOVING it to a real
// lane and lowering this number.
// 241 → 240: knowledge-base.spec.ts was WIRED (moved to `evidence-soft`) when
// the KB sharing UI landed and the spec gained an @evidence test, so the
// backlog shrinks by exactly the one spec that left it.
// 240 → 235: the core chat surface starts joining the blocking gate —
// main-chat-parity (the only spec that renders the whole thread) and
// agent-panel-parity (the only spec that renders `<ChatThread
// variant="panel">`) moved to `mock-gate`, both also @evidence-tagged and
// mapped in evidence-covers.json. The ceiling is re-pinned to the EXACT backlog
// size (the previous 240 had drifted 3 above the real 237, which silently
// bought room to re-ADD specs to the backlog), so it now ratchets on every
// wiring.
//
// One sibling chat spec was MEASURED and deliberately left unwired — a
// blocking lane runs at `retries: 0`, so a flaky member is worse than an
// unwired one (rates from repeated local runs against the mock preview):
//   - chat-message-pagination  ~4% isolated / 12-25% under lane load — the
//     highest-flake spec in the repo, and it currently protects nothing. Its
//     explicit "Load older messages" clicks race the top-sentinel
//     IntersectionObserver, which independently grows the window: the second
//     click's button detaches mid-retry (30s timeout) and the exact
//     `count === 35` assertion sees 50. FIXABLE without weakening it — give
//     the click a stable target, or suppress the top sentinel for the
//     duration of an explicit click. Worth doing; it just isn't this PR.
//
// 235 → 232: chat-stick-to-bottom + chat-scroll-restore were WIRED into
// `mock-gate` once issue #140 was FIXED (the ceiling also re-pins to the exact
// backlog size — it had drifted 1 above the real 234, which silently bought
// room to re-ADD a spec). Both used to fail on "streaming growth while at
// bottom must stay pinned" (~4% and ~2%), and it was a real product bug, not a
// settle flake: `expect.poll` burned its full 5s and never recovered. The
// jump-to-bottom button was a `position: sticky` — i.e. still IN FLOW — child
// of the scroll container, so its 2.5rem counted toward `scrollHeight`; since
// it is mounted BY the "you are not at the bottom" state it reports, mounting
// it after the stick pin kept the view exactly its own height off the bottom,
// forever. It now lives in a zero-height overlay dock. Measured on the mock
// preview: 5/40 red before the fix; after it, 300/300 (--repeat-each=30, 6
// workers) and 400/400 (--repeat-each=40, 10 workers) across both files. The
// flake is also retired as a flake — a new deterministic @evidence assertion
// (mounting the affordance must not change `scrollHeight`) fails 5/5 against
// the pre-fix component.
const UNWIRED_CEILING = 232;

function bashLines(cmd: string): string[] {
  const proc = Bun.spawnSync(["bash", "-c", cmd], { cwd: REPO_ROOT });
  if (proc.exitCode !== 0) throw new Error(`bash failed: ${cmd}\n${proc.stderr.toString()}`);
  return proc.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 0);
}

const lanes = lanesManifest.lanes as Record<string, string[]>;
const onDisk = bashLines("find web/e2e -name '*.spec.ts' | sort");
const evidenceTagged = new Set(
  bashLines("grep -rl --include='*.spec.ts' '@evidence' web/e2e || true"),
);
const dockerGated = new Set(
  bashLines("grep -rl --include='*.spec.ts' 'DOCKER_TEST' web/e2e || true"),
);

describe("e2e lane manifest", () => {
  test("lane set is exactly the five known lanes", () => {
    expect(Object.keys(lanes).sort()).toEqual([...LANE_NAMES].sort());
  });

  test("exhaustive + unique: every on-disk spec in exactly one lane, no phantom entries", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const lane of LANE_NAMES) {
      for (const f of lanes[lane]!) {
        if (seen.has(f)) dupes.push(`${f} (${seen.get(f)} + ${lane})`);
        seen.set(f, lane);
      }
    }
    expect(dupes, `spec(s) in two lanes:\n  ${dupes.join("\n  ")}`).toEqual([]);

    const onDiskSet = new Set(onDisk);
    const missing = onDisk.filter((f) => !seen.has(f));
    const phantom = [...seen.keys()].filter((f) => !onDiskSet.has(f));
    expect(
      missing,
      `spec(s) missing from web/e2e/lanes.json — assign a lane (new specs default to 'unwired' ` +
        `only by an explicit entry; a wired spec belongs in its gate's lane):\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
    expect(
      phantom,
      `manifest entries for deleted specs — remove:\n  ${phantom.join("\n  ")}`,
    ).toEqual([]);
  });

  test("real-auth lane == the real config's testDir population", () => {
    const dirSpecs = onDisk.filter((f) => f.startsWith("web/e2e/real-auth/"));
    expect(lanes["real-auth"]!.slice().sort()).toEqual(dirSpecs.sort());
  });

  test("evidence-soft members all carry @evidence; no @evidence spec is unwired", () => {
    const untagged = lanes["evidence-soft"]!.filter((f) => !evidenceTagged.has(f));
    expect(
      untagged,
      `evidence-soft entries without @evidence:\n  ${untagged.join("\n  ")}`,
    ).toEqual([]);
    const hidden = lanes.unwired!.filter((f) => evidenceTagged.has(f));
    expect(
      hidden,
      `@evidence spec(s) marked 'unwired' — they run in the capture lane; move to evidence-soft:\n  ${hidden.join("\n  ")}`,
    ).toEqual([]);
  });

  test("docker lane members are DOCKER_TEST-gated", () => {
    const unmarked = lanes.docker!.filter((f) => !dockerGated.has(f));
    expect(
      unmarked,
      `docker-lane entries without DOCKER_TEST gating:\n  ${unmarked.join("\n  ")}`,
    ).toEqual([]);
  });

  test("unwired backlog only shrinks (ceiling is the exact current size)", () => {
    expect(lanes.unwired!.length).toBeLessThanOrEqual(UNWIRED_CEILING);
  });

  test("mock-gate args generator emits one anchored web-relative regex per member", () => {
    const args = laneArgs(lanes, "mock-gate");
    expect(args.length).toBe(lanes["mock-gate"]!.length);
    for (const a of args) {
      expect(a.startsWith("e2e/")).toBe(true);
      expect(a.endsWith("\\.spec\\.ts$")).toBe(true);
    }
    // The historical substring trap: `hub.spec.ts` must NOT match
    // github-projects-hub.spec.ts / project-hub.spec.ts.
    const hub = args.find((a) => a.includes("/hub"));
    expect(hub).toBe("e2e/hub\\.spec\\.ts$");
    expect(new RegExp(hub!).test("e2e/github-projects-hub.spec.ts")).toBe(false);
    expect(new RegExp(hub!).test("e2e/project-hub.spec.ts")).toBe(false);
    expect(new RegExp(hub!).test("e2e/hub.spec.ts")).toBe(true);
  });

  test("ci.yml consumes the manifest via the generator (one home for the gate list)", async () => {
    const ci = await Bun.file(join(REPO_ROOT, ".github/workflows/ci.yml")).text();
    expect(ci).toContain("bun scripts/e2e-lane-args.ts mock-gate");
    // The old hand-listed spec regexes must not resurface beside it.
    expect(ci).not.toMatch(/e2e\/file-organizer-hub\\.spec\\.ts/);
  });
});
