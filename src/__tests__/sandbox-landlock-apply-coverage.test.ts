/**
 * In-process coverage for `applyReadWriteJail` → `applyJail` — the live FFI
 * grant body (createRuleset → grant traverse/list/rw/ro → restrict_self) that
 * otherwise runs ONLY inside the spawned shim CHILD, whose coverage the parent
 * runner can't see. The Seam-A/B live tests spawn that child; the A2 tests stub
 * `applyReadWriteJail` away. Neither exercises the real grant loop in-process,
 * so the (TRAVERSE/list/rw/ro) grant lines stay uncovered on the bwrap CI tier.
 *
 * Trick to cover them WITHOUT jailing the runner: grant `/` in EVERY access
 * class. `WRITE_ACCESS` on `/` is the full handled set, so the union grants the
 * process unrestricted access to the whole filesystem — `restrict_self` becomes
 * a functional no-op (reads / spawns / the coverage flush at exit all still
 * work) while every `grant(...)` branch — including the new TRAVERSE grant —
 * actually executes.
 *
 * DEDICATED FILE, single test: `restrict_self` is irreversible and per-process,
 * so it must not share a process with sibling suites (the per-file test +
 * coverage harnesses each run this file in its own bun process).
 */
import { test, expect, describe } from "bun:test";
import { applyReadWriteJail } from "../extensions/sandbox/landlock-ffi";
import { probeLandlockAbi } from "../extensions/sandbox/capability-probe";

// True on any landlock-capable kernel (incl. the bwrap-tier CI runner, which
// still has landlock ABI — it just prefers bwrap because userns is available).
const LANDLOCK_OK = (probeLandlockAbi() ?? 0) >= 1;

describe("landlock applyReadWriteJail — in-process grant body coverage", () => {
  test.if(LANDLOCK_OK)(
    "applies traverse/list/rw/ro grants over '/' (no-op jail) without throwing",
    () => {
      const abi = probeLandlockAbi()!;
      // rw + ro + list + traverse ALL granted on "/": every grant() branch runs;
      // the WRITE_ACCESS union over "/" leaves the runner fully unrestricted.
      expect(() =>
        applyReadWriteJail(["/"], ["/"], abi, ["/"], ["/"]),
      ).not.toThrow();

      // Proof the jail did NOT actually confine this process (granting "/" =
      // no-op): a post-restrict file read still succeeds.
      const fs = require("node:fs") as typeof import("node:fs");
      expect(fs.readFileSync(`${process.cwd()}/package.json`, "utf8").length).toBeGreaterThan(0);
    },
  );

  test.if(!LANDLOCK_OK)(
    "ABI guard: applyReadWriteJail throws on an unsupported kernel",
    () => {
      // No landlock here — exercise the ABI<1 fail-closed path instead so the
      // file still has a live assertion on a non-landlock host.
      expect(() => applyReadWriteJail([], ["/usr"], 0, [], [])).toThrow();
    },
  );
});
