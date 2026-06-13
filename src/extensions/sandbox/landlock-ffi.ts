/**
 * Low-level Landlock LSM bindings via `bun:ffi` (Phase A1 spike).
 *
 * Landlock (Linux 5.13+) is an unprivileged-process sandbox LSM: it needs
 * ZERO namespaces, ZERO capabilities, ZERO setuid — only
 * `prctl(PR_SET_NO_NEW_PRIVS)`. Its three syscalls
 *   444 landlock_create_ruleset
 *   445 landlock_add_rule
 *   446 landlock_restrict_self
 * are already allowed by Docker's default seccomp profile, so it works
 * inside the app container where the prior bwrap/netns spike failed on
 * unprivileged-userns restrictions.
 *
 * This module FFIs `syscall(2)` directly (libc `syscall` symbol) so we do
 * not depend on a Landlock-aware libc. Everything here is x86_64; the
 * syscall numbers below are the x86_64 ABI. A non-x86_64 host degrades to
 * the advisory tier in the probe (we refuse to guess syscall numbers).
 *
 * Spec: tasks/ez-code.md Phase A1. Durable path = FFI (landrun is pre-1.0
 * and not installed here).
 */

import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** x86_64 syscall numbers. */
export const SYS_landlock_create_ruleset = 444n;
export const SYS_landlock_add_rule = 445n;
export const SYS_landlock_restrict_self = 446n;
export const SYS_prctl = 157n;

/** prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0). */
export const PR_SET_NO_NEW_PRIVS = 38n;

/** landlock_create_ruleset special flag: query the supported ABI version. */
export const LANDLOCK_CREATE_RULESET_VERSION = 1n;

/** landlock_add_rule type: a path-beneath rule. */
export const LANDLOCK_RULE_PATH_BENEATH = 1n;

/**
 * Landlock fs access rights bitmask (ABI v1..v5). We request the broad
 * "handled" set when creating the ruleset, then grant the read/exec
 * subset on each allowed path. Unhandled-by-kernel bits are stripped by
 * the caller against the probed ABI version.
 */
export const LANDLOCK_ACCESS_FS = {
  EXECUTE: 1n << 0n,
  WRITE_FILE: 1n << 1n,
  READ_FILE: 1n << 2n,
  READ_DIR: 1n << 3n,
  REMOVE_DIR: 1n << 4n,
  REMOVE_FILE: 1n << 5n,
  MAKE_CHAR: 1n << 6n,
  MAKE_DIR: 1n << 7n,
  MAKE_REG: 1n << 8n,
  MAKE_SOCK: 1n << 9n,
  MAKE_FIFO: 1n << 10n,
  MAKE_BLOCK: 1n << 11n,
  MAKE_SYM: 1n << 12n,
  REFER: 1n << 13n, // ABI v2+
  TRUNCATE: 1n << 14n, // ABI v3+
} as const;

/** Read-only access subset we grant to read-only allowlisted paths. */
export const READ_ACCESS =
  LANDLOCK_ACCESS_FS.EXECUTE |
  LANDLOCK_ACCESS_FS.READ_FILE |
  LANDLOCK_ACCESS_FS.READ_DIR;

/**
 * Write-inclusive access subset granted to READ-WRITE allowlisted paths
 * (e.g. a run's workspace). It is READ_ACCESS plus the full set of
 * mutating rights so a jailed process can edit files and run git
 * (switch/add/commit) inside its workspace. REFER (ABI v2+) and TRUNCATE
 * (ABI v3+) are masked against the detected ABI by the caller — including
 * them here when the kernel doesn't support them would EINVAL the rule.
 */
export const WRITE_ACCESS =
  READ_ACCESS |
  LANDLOCK_ACCESS_FS.WRITE_FILE |
  LANDLOCK_ACCESS_FS.REMOVE_DIR |
  LANDLOCK_ACCESS_FS.REMOVE_FILE |
  LANDLOCK_ACCESS_FS.MAKE_CHAR |
  LANDLOCK_ACCESS_FS.MAKE_DIR |
  LANDLOCK_ACCESS_FS.MAKE_REG |
  LANDLOCK_ACCESS_FS.MAKE_SOCK |
  LANDLOCK_ACCESS_FS.MAKE_FIFO |
  LANDLOCK_ACCESS_FS.MAKE_BLOCK |
  LANDLOCK_ACCESS_FS.MAKE_SYM |
  LANDLOCK_ACCESS_FS.REFER |
  LANDLOCK_ACCESS_FS.TRUNCATE;

type LibcLib = ReturnType<typeof dlopen<typeof FFI_SYMBOLS>>;
let lib: LibcLib | null = null;

const FFI_SYMBOLS = {
  // syscall(number, a1, a2, a3, a4, a5) — number + 5 args. Landlock's
  // add_rule needs the trailing `flags` arg and prctl needs arg2..arg5,
  // so we MUST declare all five (a short binding silently drops them and
  // the kernel reads garbage from the missing registers → EINVAL).
  syscall: {
    args: [
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
      FFIType.i64,
    ],
    returns: FFIType.i64,
  },
  open: {
    args: [FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
  close: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  __errno_location: {
    args: [],
    returns: FFIType.ptr,
  },
} as const;

/**
 * Resolve a usable libc path across distros:
 *  - Debian/Ubuntu (the app container): `libc.so.6` is on the loader path.
 *  - NixOS (the dev host): there is no bare `libc.so.6` on the default
 *    search path, so derive the real path the running Bun is linked
 *    against via `ldd`.
 * Returns an ordered candidate list; the first that `dlopen`s wins.
 */
function libcCandidates(): string[] {
  const cands = ["libc.so.6"];
  try {
    const out = execFileSync("ldd", [process.execPath], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = line.match(/libc\.so\.6\s*=>\s*(\S+)/);
      if (m?.[1]) cands.push(m[1]);
    }
  } catch {
    // ldd missing or static — fall through to the basename candidate.
  }
  // Common absolute locations as a last resort.
  cands.push("/lib/x86_64-linux-gnu/libc.so.6", "/usr/lib/libc.so.6");
  return cands;
}

function libc(): LibcLib {
  if (lib) return lib;
  // libc exposes `syscall` and `open`/`close`. We bind syscall as the raw
  // gate (variadic — Bun maps fixed args; Landlock uses 3 args max).
  let lastErr: unknown;
  for (const cand of libcCandidates()) {
    try {
      lib = dlopen(cand, FFI_SYMBOLS);
      return lib;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`landlock-ffi: could not dlopen libc: ${String(lastErr)}`);
}

/** Read thread-local errno after a -1 syscall return. */
export function errno(): number {
  const loc = libc().symbols.__errno_location();
  if (!loc) return 0;
  const buf = toArrayBuffer(loc, 0, 4);
  return new Int32Array(buf)[0] ?? 0;
}

/**
 * Probe the supported Landlock ABI version.
 * Returns the version (>0) on success, or -1 if Landlock is unsupported
 * (ENOSYS / EOPNOTSUPP) — i.e. the syscall is filtered or the LSM is not
 * active.
 */
export function landlockAbiVersion(): number {
  const r = libc().symbols.syscall(
    SYS_landlock_create_ruleset,
    0n, // attr = NULL
    0n, // size = 0
    LANDLOCK_CREATE_RULESET_VERSION,
    0n,
    0n,
  );
  const n = Number(r);
  return n;
}

/** prctl(PR_SET_NO_NEW_PRIVS, 1). Required before restrict_self. */
export function setNoNewPrivs(): number {
  const r = libc().symbols.syscall(
    SYS_prctl,
    PR_SET_NO_NEW_PRIVS,
    1n,
    0n,
    0n,
    0n,
  );
  return Number(r);
}

/**
 * Create a Landlock ruleset handling the given fs-access bitmask.
 * The kernel struct `landlock_ruleset_attr` (ABI v1) is a single
 * `__u64 handled_access_fs`. Returns the ruleset fd (>=0) or -1.
 */
export function createRuleset(handledAccessFs: bigint): number {
  const attr = new BigUint64Array(1);
  attr[0] = handledAccessFs;
  const r = libc().symbols.syscall(
    SYS_landlock_create_ruleset,
    BigInt(ptr(attr)),
    8n, // sizeof(struct landlock_ruleset_attr) for ABI v1
    0n, // flags
    0n,
    0n,
  );
  return Number(r);
}

/**
 * Add a path-beneath rule granting `allowedAccess` on the directory `path`.
 * The kernel struct `landlock_path_beneath_attr` is
 *   { __u64 allowed_access; __s32 parent_fd; } (packed -> 12 bytes, but the
 * kernel reads it field-by-field; we lay out 16 bytes with the fd at +8).
 * Returns 0 on success, -1 on error. Opens (and closes) `path` O_PATH.
 */
export function addPathBeneathRule(
  rulesetFd: number,
  path: string,
  allowedAccess: bigint,
): number {
  const O_PATH = 0x200000;
  const O_CLOEXEC = 0x80000;
  const cpath = Buffer.from(path + "\0", "utf8");
  const fd = libc().symbols.open(cpath, O_PATH | O_CLOEXEC);
  if (fd < 0) return -1;
  try {
    // struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; }
    // Layout in a 16-byte buffer: [0..8) allowed_access, [8..12) parent_fd.
    // Use a stable node Buffer (not a transient Uint8Array view) so the GC
    // can't relocate the backing store between ptr() and the syscall.
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(allowedAccess, 0);
    buf.writeInt32LE(fd, 8);
    // syscall(445, ruleset_fd, rule_type, rule_attr, FLAGS=0). The trailing
    // `flags` arg is mandatory — omitting it makes the kernel read garbage
    // and return EINVAL.
    const r = libc().symbols.syscall(
      SYS_landlock_add_rule,
      BigInt(rulesetFd),
      LANDLOCK_RULE_PATH_BENEATH,
      BigInt(ptr(buf)),
      0n,
      0n,
    );
    return Number(r);
  } finally {
    libc().symbols.close(fd);
  }
}

/** landlock_restrict_self(ruleset_fd, 0). Returns 0 on success, -1 on error. */
export function restrictSelf(rulesetFd: number): number {
  const r = libc().symbols.syscall(
    SYS_landlock_restrict_self,
    BigInt(rulesetFd),
    0n, // flags
    0n,
    0n,
    0n,
  );
  return Number(r);
}

/** Close a raw fd. */
export function closeFd(fd: number): void {
  libc().symbols.close(fd);
}

/**
 * The FULL fs-access set this kernel ABI handles (i.e. enforces). Any
 * access NOT in the handled set is left UNRESTRICTED by Landlock; any
 * access IN the handled set but NOT granted on a path is DENIED. We always
 * handle the complete write+read set (masked to the ABI) so that
 * read-only paths genuinely lose write access and read-write paths gain it.
 */
export function handledAccessForAbi(abiVersion: number): bigint {
  let handled =
    LANDLOCK_ACCESS_FS.EXECUTE |
    LANDLOCK_ACCESS_FS.WRITE_FILE |
    LANDLOCK_ACCESS_FS.READ_FILE |
    LANDLOCK_ACCESS_FS.READ_DIR |
    LANDLOCK_ACCESS_FS.REMOVE_DIR |
    LANDLOCK_ACCESS_FS.REMOVE_FILE |
    LANDLOCK_ACCESS_FS.MAKE_CHAR |
    LANDLOCK_ACCESS_FS.MAKE_DIR |
    LANDLOCK_ACCESS_FS.MAKE_REG |
    LANDLOCK_ACCESS_FS.MAKE_SOCK |
    LANDLOCK_ACCESS_FS.MAKE_FIFO |
    LANDLOCK_ACCESS_FS.MAKE_BLOCK |
    LANDLOCK_ACCESS_FS.MAKE_SYM;
  if (abiVersion >= 2) handled |= LANDLOCK_ACCESS_FS.REFER;
  if (abiVersion >= 3) handled |= LANDLOCK_ACCESS_FS.TRUNCATE;
  return handled;
}

/**
 * Core jail applier: grant `rwAccess`-masked rights to each `rwPaths` entry
 * and `roAccess`-masked rights to each `roPaths` entry, then restrict_self.
 * Pre-`restrict_self`, prctl(NO_NEW_PRIVS) is set. Throws (fail-closed) on
 * any failure. Non-existent allow paths are silent no-ops (distro-portable).
 */
function applyJail(
  rwPaths: readonly string[],
  roPaths: readonly string[],
  abiVersion: number,
): void {
  if (abiVersion < 1) {
    throw new Error(`landlock: unsupported ABI version ${abiVersion}`);
  }
  const handled = handledAccessForAbi(abiVersion);
  const rulesetFd = createRuleset(handled);
  if (rulesetFd < 0) {
    throw new Error(`landlock: create_ruleset failed errno=${errno()}`);
  }
  const grant = (paths: readonly string[], access: bigint): void => {
    for (const p of paths) {
      // A non-existent allow path is a no-op (you cannot grant access to
      // what isn't there) — common for optional system dirs that differ
      // across distros (e.g. /nix on NixOS, absent in the container).
      if (!existsSync(p)) continue;
      const rc = addPathBeneathRule(rulesetFd, p, access & handled);
      if (rc !== 0) {
        throw new Error(`landlock: add_rule(${p}) failed errno=${errno()}`);
      }
    }
  };
  try {
    // Grant write-inclusive access to rw paths FIRST, then read-only to ro
    // paths. A path appearing in both would be additively unioned by the
    // kernel, but callers keep the sets disjoint (the rw workspace is never
    // also passed as ro).
    grant(rwPaths, WRITE_ACCESS);
    grant(roPaths, READ_ACCESS);
    if (setNoNewPrivs() !== 0) {
      throw new Error(`landlock: prctl(NO_NEW_PRIVS) failed errno=${errno()}`);
    }
    if (restrictSelf(rulesetFd) !== 0) {
      throw new Error(`landlock: restrict_self failed errno=${errno()}`);
    }
  } finally {
    closeFd(rulesetFd);
  }
}

/**
 * Apply a READ-ONLY Landlock fs jail to the CURRENT process: only paths
 * under `allowedReadPaths` remain readable/executable; every other path
 * loses read/exec access AND all write access. Throws on any failure
 * (fail-closed).
 *
 * Strips access bits unsupported by the probed ABI so the create call does
 * not EINVAL on older kernels.
 */
export function applyReadOnlyJail(
  allowedReadPaths: readonly string[],
  abiVersion: number,
): void {
  applyJail([], allowedReadPaths, abiVersion);
}

/**
 * Apply a READ-WRITE Landlock fs jail to the CURRENT process: `rwPaths`
 * get write-inclusive access (read/exec/write/make/remove/truncate, masked
 * to the ABI) so a jailed process can edit files + run git in its
 * workspace; `roPaths` get read/exec only. Every path NOT in either set
 * loses all access. Throws on any failure (fail-closed).
 */
export function applyReadWriteJail(
  rwPaths: readonly string[],
  roPaths: readonly string[],
  abiVersion: number,
): void {
  applyJail(rwPaths, roPaths, abiVersion);
}
