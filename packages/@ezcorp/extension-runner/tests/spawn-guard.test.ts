import { describe, expect, test } from "bun:test";
import { bunWorkerArgs, processSpawnFilter, pythonWorkerArgs, SECCOMP_RET_ALLOW, SECCOMP_RET_ERRNO, SECCOMP_RET_KILL_PROCESS, SPAWN_FILTER_ARCHES } from "../src/spawn-guard";

/** Runs the classic BPF program on one `struct seccomp_data`, with only the opcodes the filter uses. */
function evaluate(program: Uint8Array, data: { arch: number; nr: number; arg0?: number }): number {
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const field = (offset: number) => offset === 0 ? data.nr >>> 0 : offset === 4 ? data.arch >>> 0 : offset === 16 ? (data.arg0 ?? 0) >>> 0 : 0;
  let accumulator = 0;
  for (let pc = 0; pc * 8 < program.byteLength;) {
    const code = view.getUint16(pc * 8, true), jt = view.getUint8(pc * 8 + 2), jf = view.getUint8(pc * 8 + 3), k = view.getUint32(pc * 8 + 4, true);
    if (code === 0x06) return k;
    if (code === 0x20) { accumulator = field(k); pc += 1; continue; }
    const taken = code === 0x15 ? accumulator === k : code === 0x35 ? accumulator >= k : code === 0x45 ? (accumulator & k) !== 0 : (() => { throw new Error(`opcode ${code}`); })();
    pc += 1 + (taken ? jt : jf);
  }
  throw new Error("program fell off its end");
}

const program = processSpawnFilter();
const EPERM = SECCOMP_RET_ERRNO | 1;
const ENOSYS = SECCOMP_RET_ERRNO | 38;

describe("processSpawnFilter", () => {
  for (const arch of SPAWN_FILTER_ARCHES) {
    test(`${arch.bun}: every process-creating and process-reaching syscall is refused with EPERM`, () => {
      for (const nr of Object.values(arch.denied)) expect(evaluate(program, { arch: arch.audit, nr })).toBe(EPERM);
    });
    test(`${arch.bun}: clone makes threads but not processes, and clone3 falls back to clone`, () => {
      expect(evaluate(program, { arch: arch.audit, nr: arch.clone, arg0: 0x003d0f00 })).toBe(SECCOMP_RET_ALLOW);
      expect(evaluate(program, { arch: arch.audit, nr: arch.clone, arg0: 0x4111 })).toBe(EPERM);
      expect(evaluate(program, { arch: arch.audit, nr: arch.clone3 })).toBe(ENOSYS);
    });
    test(`${arch.bun}: ordinary syscalls are allowed`, () => {
      for (const nr of [0, 1, 3, arch.seccomp]) expect(evaluate(program, { arch: arch.audit, nr })).toBe(SECCOMP_RET_ALLOW);
    });
  }
  test("x32 numbers on x86_64 are refused, and any other architecture is killed", () => {
    const x64 = SPAWN_FILTER_ARCHES[0]!;
    expect(evaluate(program, { arch: x64.audit, nr: 0x40000000 + 59 })).toBe(EPERM);
    expect(evaluate(program, { arch: 0x40000003, nr: 11 })).toBe(SECCOMP_RET_KILL_PROCESS);
  });
});

describe("worker argv", () => {
  test("allow keeps the plain worker, deny loads the guard first and ignores workspace config", () => {
    expect(bunWorkerArgs("allow")).toEqual(["./.runner/extension.js"]);
    expect(bunWorkerArgs("deny")).toEqual(["--config=/dev/null", "--preload=./.runner/spawn-guard.js", "./.runner/extension.js"]);
    expect(pythonWorkerArgs("allow")).toEqual(["-u", "./.runner/extension.py"]);
    expect(pythonWorkerArgs("deny")).toEqual(["-I", "-u", "./.runner/spawn-guard.py"]);
  });
});
