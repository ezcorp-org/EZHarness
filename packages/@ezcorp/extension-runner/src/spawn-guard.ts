import type { ProcessSpawnPolicy } from "@ezcorp/extension-contract";

/**
 * The process-spawn guard: a seccomp filter a worker installs on itself before
 * any extension code runs, when its start carries `processSpawn: "deny"`.
 *
 * It stacks on top of the container's own profile, so it can only take
 * syscalls away. What it takes away:
 *   - `execve`, `execveat`, `fork`, `vfork`: EPERM. No new program and no new process.
 *   - `clone`: EPERM unless the flags hold `CLONE_THREAD`, so threads still work.
 *   - `clone3`: ENOSYS. Its flags sit behind a pointer the filter cannot read, and
 *     ENOSYS makes the C library fall back to `clone`, which the filter can read.
 *   - `ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_getfd`: EPERM, so the
 *     worker cannot take over a process that may still spawn (its parent shim).
 *   - x32 syscall numbers on x86_64: EPERM, so the table cannot be bypassed.
 *   - any other architecture (an i386 `int 0x80` call included): the process is killed.
 *
 * The filter is installed with `SECCOMP_FILTER_FLAG_TSYNC`, so every thread the
 * runtime already started carries it too, and a child thread inherits it. A
 * guard that cannot install the filter, or that can still start a process after
 * it did, exits with SPAWN_GUARD_FAILED before the extension runs: fail closed.
 */
export const SPAWN_GUARD_FAILED = 70;

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;
export const SECCOMP_RET_KILL_PROCESS = 0x80000000;
export const SECCOMP_RET_ERRNO = 0x00050000;
export const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;
const ENOSYS = 38;
const CLONE_THREAD = 0x10000;
const X32_SYSCALL_BIT = 0x40000000;
/** `struct seccomp_data`: nr, arch, instruction pointer, then six 64-bit arguments. */
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;
const SECCOMP_DATA_ARG0_LOW = 16;

interface SpawnFilterArch {
  readonly audit: number;
  /** Bun's `process.arch` and Python's `platform.machine()` for this architecture. */
  readonly bun: string;
  readonly python: string;
  readonly seccomp: number;
  readonly clone: number;
  readonly clone3: number;
  readonly denied: Readonly<Record<string, number>>;
  readonly compatBit: boolean;
}

/** The syscall numbers the filter names, per supported architecture. */
export const SPAWN_FILTER_ARCHES: readonly SpawnFilterArch[] = Object.freeze<SpawnFilterArch[]>([
  { audit: 0xc000003e, bun: "x64", python: "x86_64", seccomp: 317, clone: 56, clone3: 435, compatBit: true, denied: { execve: 59, execveat: 322, fork: 57, vfork: 58, ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, pidfd_getfd: 438 } },
  { audit: 0xc00000b7, bun: "arm64", python: "aarch64", seccomp: 277, clone: 220, clone3: 435, compatBit: false, denied: { execve: 221, execveat: 281, ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, pidfd_getfd: 438 } },
]);

type Step = string | { code: number; k: number; jt?: string; jf?: string };
const load = (offset: number): Step => ({ code: BPF_LD_W_ABS, k: offset });
const jump = (code: number, k: number, jt?: string, jf?: string): Step => ({ code, k, jt, jf });
const ret = (k: number): Step => ({ code: BPF_RET_K, k });

function archSteps(arch: SpawnFilterArch): Step[] {
  return [
    arch.bun,
    load(SECCOMP_DATA_NR),
    ...(arch.compatBit ? [jump(BPF_JGE_K, X32_SYSCALL_BIT, "eperm")] : []),
    ...Object.values(arch.denied).map(nr => jump(BPF_JEQ_K, nr, "eperm")),
    jump(BPF_JEQ_K, arch.clone, "clone"),
    jump(BPF_JEQ_K, arch.clone3, "enosys", "allow"),
  ];
}

/** Resolves labels to the forward offsets classic BPF takes, then writes `struct sock_filter` entries. */
function assemble(steps: readonly Step[]): Uint8Array {
  const labels = new Map<string, number>();
  const program: Exclude<Step, string>[] = [];
  for (const step of steps) if (typeof step === "string") labels.set(step, program.length); else program.push(step);
  const bytes = new Uint8Array(program.length * 8);
  const view = new DataView(bytes.buffer);
  program.forEach((instruction, index) => {
    // Every jump goes forward and the program is far shorter than 256 entries, so a jump always fits its byte.
    const offset = (label?: string) => label === undefined ? 0 : labels.get(label)! - index - 1;
    view.setUint16(index * 8, instruction.code, true);
    view.setUint8(index * 8 + 2, offset(instruction.jt));
    view.setUint8(index * 8 + 3, offset(instruction.jf));
    view.setUint32(index * 8 + 4, instruction.k >>> 0, true);
  });
  return bytes;
}

/** The filter program as `struct sock_filter[]` bytes. It is the same for every architecture it supports. */
export function processSpawnFilter(): Uint8Array {
  const [x64, arm64] = SPAWN_FILTER_ARCHES as [SpawnFilterArch, SpawnFilterArch];
  return assemble([
    load(SECCOMP_DATA_ARCH),
    jump(BPF_JEQ_K, x64.audit, x64.bun),
    jump(BPF_JEQ_K, arm64.audit, arm64.bun, "kill"),
    ...archSteps(x64),
    ...archSteps(arm64),
    "clone",
    load(SECCOMP_DATA_ARG0_LOW),
    jump(BPF_JSET_K, CLONE_THREAD, "allow", "eperm"),
    "allow", ret(SECCOMP_RET_ALLOW),
    "eperm", ret(SECCOMP_RET_ERRNO | EPERM),
    "enosys", ret(SECCOMP_RET_ERRNO | ENOSYS),
    "kill", ret(SECCOMP_RET_KILL_PROCESS),
  ]);
}

const filterBase64 = Buffer.from(processSpawnFilter()).toString("base64");
const seccompNumbers = (key: "bun" | "python") => JSON.stringify(Object.fromEntries(SPAWN_FILTER_ARCHES.map(arch => [arch[key], arch.seccomp])));

/**
 * The Bun guard. It sets no_new_privs (podman and setpriv already did; the
 * kernel requires it), installs the filter on every thread, then proves a
 * process can no longer start. It runs as a `--preload`, so it finishes before
 * the extension's first line.
 */
export const BUN_SPAWN_GUARD = `const fail=m=>{try{require("node:fs").writeSync(2,"spawn guard: "+m+"\\n")}catch{}process.exit(${SPAWN_GUARD_FAILED})};
try{const{dlopen,ptr}=require("bun:ffi");const nr=${seccompNumbers("bun")}[process.arch];if(!nr)fail("unsupported architecture");
const libc=dlopen("libc.so.6",{syscall:{args:["i64","i64","i64","ptr"],returns:"i64"},prctl:{args:["i32","u64","u64","u64","u64"],returns:"i32"}}).symbols;
const filter=Buffer.from("${filterBase64}","base64");const prog=new BigUint64Array([BigInt(filter.length/8),BigInt(ptr(filter))]);
if(libc.prctl(38,1,0,0,0)!==0)fail("no_new_privs was refused");if(Number(libc.syscall(nr,1,1,ptr(prog)))!==0)fail("the filter was refused")}catch(e){fail(String(e))}
let started=false;try{started=Bun.spawnSync([process.execPath,"--version"]).exitCode===0}catch{}if(started)fail("a process still started");`;

/** The Python guard: the same steps through ctypes, run under `-I` so no workspace module can shadow the standard library. */
export const PYTHON_SPAWN_GUARD = `import base64,ctypes,os,platform,sys
def fail(m):
    os.write(2,("spawn guard: "+m+"\\n").encode()); os._exit(${SPAWN_GUARD_FAILED})
try:
    nr=${seccompNumbers("python")}.get(platform.machine())
    if nr is None: fail("unsupported architecture")
    libc=ctypes.CDLL(None,use_errno=True)
    filt=base64.b64decode("${filterBase64}")
    buf=ctypes.create_string_buffer(filt,len(filt))
    class Prog(ctypes.Structure): _fields_=[("len",ctypes.c_ushort),("filter",ctypes.c_void_p)]
    prog=Prog(len(filt)//8,ctypes.cast(buf,ctypes.c_void_p))
    libc.prctl.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]
    libc.syscall.restype=ctypes.c_long
    if libc.prctl(38,1,0,0,0)!=0: fail("no_new_privs was refused")
    if libc.syscall(ctypes.c_long(nr),ctypes.c_long(1),ctypes.c_long(1),ctypes.byref(prog))!=0: fail("the filter was refused")
except Exception as e:
    fail(repr(e))
try:
    pid=os.posix_spawn(sys.executable,[sys.executable,"-c","pass"],{})
except OSError:
    pid=0
if pid:
    os.waitpid(pid,0); fail("a process still started")
`;

/** Where a "deny" worker's guard is staged, beside the runner's other read-only files. */
export const BUN_SPAWN_GUARD_PATH = ".runner/spawn-guard.js";
export const PYTHON_SPAWN_GUARD_PATH = ".runner/spawn-guard.py";

/**
 * The worker's own argv after the interpreter. A "deny" worker loads the guard
 * first and ignores any `bunfig.toml` in the workspace, which could otherwise
 * preload release code before the guard.
 */
export function bunWorkerArgs(policy: ProcessSpawnPolicy): string[] {
  return policy === "allow" ? ["./.runner/extension.js"] : ["--config=/dev/null", `--preload=./${BUN_SPAWN_GUARD_PATH}`, "./.runner/extension.js"];
}

/** The Python counterpart: the staged guard installs the filter, then runs the launcher as `__main__`. */
export function pythonWorkerArgs(policy: ProcessSpawnPolicy): string[] {
  return policy === "allow" ? ["-u", "./.runner/extension.py"] : ["-I", "-u", `./${PYTHON_SPAWN_GUARD_PATH}`];
}

export const PYTHON_SPAWN_GUARD_FILE = `${PYTHON_SPAWN_GUARD}import runpy
sys.argv=["./.runner/extension.py"]
runpy.run_path("./.runner/extension.py",run_name="__main__")
`;

/**
 * The shim's first act: PR_SET_DUMPABLE 0. A worker runs as the shim's uid, and
 * the shim keeps the right to start processes; a dumpable shim would let the
 * worker write `/proc/<ppid>/mem` or attach to it even under Yama scope 0.
 * Non-dumpable, both need CAP_SYS_PTRACE, which no guest holds.
 */
export const BUN_SHIM_UNDUMPABLE = `if(require("bun:ffi").dlopen("libc.so.6",{prctl:{args:["i32","u64","u64","u64","u64"],returns:"i32"}}).symbols.prctl(4,0,0,0,0)!==0)process.exit(${SPAWN_GUARD_FAILED});`;
export const PYTHON_SHIM_UNDUMPABLE = `import ctypes
if ctypes.CDLL(None).prctl(4,0,0,0,0)!=0: sys.exit(${SPAWN_GUARD_FAILED})
`;
