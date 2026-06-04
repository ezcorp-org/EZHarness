import { test, expect, describe } from "bun:test";
import {
  parseProcNetTcp,
  ProcPortSource,
  StaticPortSource,
} from "../runtime/preview/preview-port-source";

// ── Fixture /proc/net/tcp content ──────────────────────────────────────
//
// Columns: sl  local_address rem_address st ... uid ...
// 0100007F:1538 = 127.0.0.1:5432  (st 0A = LISTEN, uid 1000 = app)
// 00000000:1F90 = 0.0.0.0:8080    (st 0A = LISTEN, uid 90001 = preview)
// 00000000:0050 = 0.0.0.0:80      (st 01 = ESTABLISHED, not LISTEN)
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 ffff
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 90001        0 23456 1 ffff
   2: 00000000:0050 0A0A0A0A:1234 01 00000000:00000000 00:00000000 00000000 90001        0 34567 1 ffff
`;

// tcp6 fixture: a preview-uid LISTEN socket on port 5173 (vite default).
// 00000000000000000000000000000000:1435 = [::]:5173, st 0A, uid 90002.
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st ... uid
   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 90002 0 45678 1 ffff
`;

describe("parseProcNetTcp", () => {
  test("keeps only LISTEN sockets (st == 0A), decodes port + uid", () => {
    const rows = parseProcNetTcp(PROC_NET_TCP);
    // The ESTABLISHED row (st 01) is dropped; two LISTEN rows remain.
    expect(rows).toEqual([
      { port: 0x1538, uid: 1000 }, // 5432, app
      { port: 0x1f90, uid: 90001 }, // 8080, preview
    ]);
  });

  test("parses tcp6 LISTEN rows the same way", () => {
    const rows = parseProcNetTcp(PROC_NET_TCP6);
    expect(rows).toEqual([{ port: 0x1435, uid: 90002 }]); // 5173
  });

  test("skips the header line", () => {
    const rows = parseProcNetTcp("  sl  local_address rem_address   st\n");
    expect(rows).toEqual([]);
  });

  test("skips malformed lines defensively (never throws)", () => {
    const malformed = `garbage
   0: NOTACOLON 00000000:0000 0A 00000000:00000000 00:00000000 00000000 90001 0 0 1 ffff
   1: 00000000:ZZZZ 00000000:0000 0A 00000000:00000000 00:00000000 00000000 90001 0 0 1 ffff
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 90001 0 0 1 ffff`;
    const rows = parseProcNetTcp(malformed);
    // Only the last (valid) row survives.
    expect(rows).toEqual([{ port: 0x1f90, uid: 90001 }]);
  });

  test("rejects out-of-range ports", () => {
    const bad = `   0: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000 90001 0 0 1 ffff`;
    expect(parseProcNetTcp(bad)).toEqual([]); // port 0 rejected
  });

  test("empty content -> empty", () => {
    expect(parseProcNetTcp("")).toEqual([]);
  });
});

describe("ProcPortSource — uid-attributed enumeration", () => {
  test("returns only ports owned by THIS conversation (uid map hit)", () => {
    const uidMap = new Map<number, string>([
      [90001, "conv-A"],
      [90002, "conv-B"],
    ]);
    const src = new ProcPortSource(
      () => PROC_NET_TCP + PROC_NET_TCP6,
      (uid) => uidMap.get(uid),
    );
    // conv-A owns uid 90001 → port 8080. The app uid (1000) socket is NOT
    // attributed (not in the preview pool). conv-B's 5173 belongs to B.
    expect(src.listListeners("conv-A")).toEqual([{ port: 0x1f90 }]); // 8080
    expect(src.listListeners("conv-B")).toEqual([{ port: 0x1435 }]); // 5173
  });

  test("uid-map miss → no attribution (app/system sockets ignored)", () => {
    const src = new ProcPortSource(
      () => PROC_NET_TCP, // contains uid 1000 (app) + 90001
      () => undefined, // nothing maps
    );
    expect(src.listListeners("conv-A")).toEqual([]);
  });

  test("dedups a port bound on both tcp and tcp6", () => {
    // Same uid + same port on both families.
    const dualStack = `   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 90001 0 0 1 ffff`;
    const dualStack6 = `   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 90001 0 0 1 ffff`;
    const src = new ProcPortSource(
      () => `${dualStack}\n${dualStack6}`,
      (uid) => (uid === 90001 ? "conv-A" : undefined),
    );
    expect(src.listListeners("conv-A")).toEqual([{ port: 0x1f90 }]);
  });

  test("empty conversation id → empty", () => {
    const src = new ProcPortSource(() => PROC_NET_TCP, () => "conv-A");
    expect(src.listListeners("")).toEqual([]);
  });

  test("a throwing proc reader yields nothing (logged, fail-safe)", () => {
    const src = new ProcPortSource(
      () => {
        throw new Error("EACCES");
      },
      () => "conv-A",
    );
    expect(src.listListeners("conv-A")).toEqual([]);
  });
});

describe("StaticPortSource (regression — still works)", () => {
  test("returns programmed listeners", () => {
    const src = new StaticPortSource();
    src.set("conv-A", [5173, 8080]);
    expect(src.listListeners("conv-A")).toEqual([{ port: 5173 }, { port: 8080 }]);
    expect(src.listListeners("unknown")).toEqual([]);
  });
});
