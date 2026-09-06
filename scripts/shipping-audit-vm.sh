#!/usr/bin/env bash
# Boot an owned KVM guest and prove that the production seccomp BPF emits a
# kernel audit record for the exact child PID.  Nothing in this script changes
# host audit, sysctl, or network state.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=${EZCORP_AUDIT_IMAGE:-localhost/ezcorp-extension-v4:terra-final-26541024}
kernel=${EZCORP_AUDIT_KERNEL:-/run/current-system/kernel}
compiler=${EZCORP_AUDIT_MUSL_GCC:-/nix/store/8x3g3yrvi197bbw1g1cpmwll4b648nz4-musl-static-x86_64-unknown-linux-musl-1.2.5-dev/bin/musl-gcc}
real_gcc=${EZCORP_AUDIT_REAL_GCC:-/nix/store/h07xxi23n3vxrwxhz0v1v4m9a2cn12lc-x86_64-unknown-linux-musl-gcc-wrapper-15.2.0/bin/x86_64-unknown-linux-musl-gcc}
out=${1:-"$repo/docs/validation/extension-v4-shipping/security/vm-seccomp-audit.log"}

for required in "$kernel" "$compiler" "$real_gcc"; do
  [[ -e "$required" ]] || { echo "missing required path: $required" >&2; exit 2; }
done
command -v qemu-system-x86_64 >/dev/null || { echo "qemu-system-x86_64 is required" >&2; exit 2; }
command -v cpio >/dev/null || { echo "cpio is required" >&2; exit 2; }
command -v timeout >/dev/null || { echo "timeout is required" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/ez-shipping-audit-vm.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT INT TERM
root="$work/root"
mkdir -p "$root"/{proc,sys,dev,tmp}

cid=$(CONMON=/tmp/ez-audit-ci-conmon DOCKER_HOST=unix:///run/user/1001/podman/podman.sock podman create --pull=never "$image")
cleanup_container() { CONMON=/tmp/ez-audit-ci-conmon DOCKER_HOST=unix:///run/user/1001/podman/podman.sock podman rm "$cid" >/dev/null 2>&1 || true; }
trap 'cleanup_container; cleanup' EXIT INT TERM
CONMON=/tmp/ez-audit-ci-conmon DOCKER_HOST=unix:///run/user/1001/podman/podman.sock podman cp "$cid:/app/src/extensions/mcp-seccomp.bpf" "$work/production.bpf"
cleanup_container
trap cleanup EXIT INT TERM

cat >"$work/load-production-seccomp.c" <<'C'
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

/* seccomp_export_bpf writes the raw sock_filter[] program.  It has no bwrap
 * header: its byte length must therefore be an exact instruction multiple. */
int main(void) {
  int fd = open("/production.bpf", O_RDONLY);
  struct sock_filter *filters;
  struct sock_fprog program;
  off_t bytes;
  size_t count;
  long allowed, denied;
  if (fd < 0 || (bytes = lseek(fd, 0, SEEK_END)) <= 0 ||
      bytes % (off_t)sizeof(*filters) != 0 || lseek(fd, 0, SEEK_SET) < 0) return 20;
  count = (size_t)bytes / sizeof(*filters);
  if (count > 4096 || count > 65535) return 20;
  filters = calloc(count, sizeof(*filters));
  if (!filters || read(fd, filters, bytes) != bytes) return 21;
  program.len = (unsigned short)count; program.filter = filters;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 22;
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) != 0) return 23;
  fprintf(stderr, "VM_PROBE_PID=%ld\n", (long)getpid());
  errno = 0; allowed = syscall(SYS_getpid);
  fprintf(stderr, "VM_PROBE_GETPID=%ld errno=%d\n", allowed, errno);
  errno = 0; denied = syscall(SYS_io_uring_setup, 0, NULL);
  fprintf(stderr, "VM_PROBE_IO_URING=%ld errno=%d\n", denied, errno);
  return allowed > 0 && denied == -1 && errno == ENOSYS ? 0 : 24;
}
C
REALGCC="$real_gcc" "$compiler" -static -O2 -Wall -Wextra -o "$root/probe-production-seccomp" "$work/load-production-seccomp.c"
cp "$work/production.bpf" "$root/production.bpf"

cat >"$work/init.c" <<'C'
#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/reboot.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/klog.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void show(const char *path, const char *name) {
  char value[256] = {0}; int fd = open(path, O_RDONLY); ssize_t n;
  if (fd < 0) return;
  n = read(fd, value, sizeof(value) - 1);
  close(fd);
  if (n > 0) { while (n > 0 && (value[n - 1] == '\n' || value[n - 1] == ' ')) value[--n] = 0; printf("%s=%s ", name, value); }
}
int main(void) {
  int console, status = 127, bytes; char logs[65536]; pid_t child;
  mount("proc", "/proc", "proc", 0, NULL);
  mount("sysfs", "/sys", "sysfs", 0, NULL);
  mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
  console = open("/dev/console", O_RDWR); if (console >= 0) { dup2(console, 0); dup2(console, 1); dup2(console, 2); }
  printf("VM_AUDIT_BOOTED "); show("/proc/sys/kernel/audit_enabled", "audit_enabled"); show("/proc/sys/kernel/seccomp/actions_logged", "actions_logged"); puts("");
  child = fork();
  if (child == 0) { char *args[] = { "/probe-production-seccomp", NULL }; execv(args[0], args); _exit(127); }
  if (child > 0) waitpid(child, &status, 0);
  bytes = klogctl(3, logs, sizeof(logs) - 1);
  if (bytes > 0) { logs[bytes] = 0; fputs(logs, stdout); }
  printf("VM_PROBE_STATUS=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : 127);
  sync(); reboot(LINUX_REBOOT_CMD_POWER_OFF); return 0;
}
C
REALGCC="$real_gcc" "$compiler" -static -O2 -Wall -Wextra -o "$root/init" "$work/init.c"

mkdir -p "$(dirname "$out")"
( cd "$root" && find . -print | cpio -o -H newc ) >"$work/initramfs.cpio"
set +e
timeout --foreground --kill-after=5s 45s qemu-system-x86_64 -enable-kvm -m 512M -kernel "$kernel" -initrd "$work/initramfs.cpio" \
  -append 'console=ttyS0 audit=1 panic=-1' -display none -serial stdio -no-reboot 2>&1 | tr -d '\r' | tee "$out"
qemu_status=${PIPESTATUS[0]}
set -e
[[ $qemu_status -eq 0 ]] || { echo "qemu exit=$qemu_status" >&2; exit "$qemu_status"; }
grep -Eq 'audit: type=2000 .*audit_enabled=1' "$out"
grep -q '^VM_PROBE_GETPID=[1-9][0-9]* errno=0$' "$out"
grep -q '^VM_PROBE_IO_URING=-1 errno=38$' "$out"
pid=$(sed -n 's/^VM_PROBE_PID=\([1-9][0-9]*\)$/\1/p' "$out" | tail -n 1)
[[ -n "$pid" ]] || { echo "probe PID was not emitted" >&2; exit 25; }
grep -Eq "type=1326 .* pid=${pid}( |$)" "$out" || { echo "no seccomp audit row for guest pid $pid" >&2; exit 26; }
echo "VM_AUDIT_ASSERTION=PASS pid=$pid" | tee -a "$out"
