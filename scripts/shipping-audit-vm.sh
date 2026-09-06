#!/usr/bin/env bash
# Boot an owned KVM guest and prove that the retained MCP seccomp BPF emits a
# kernel audit record for the exact child PID. Nothing in this script changes
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
audit_podman() { CONMON="${CONMON:-/tmp/ez-audit-ci-conmon}" podman --remote=false "$@"; }
image_id=$(audit_podman image inspect "$image" --format '{{.Id}}')
image_source=$(audit_podman image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
image="$image_id"

work=$(mktemp -d "${TMPDIR:-/tmp}/ez-shipping-audit-vm.XXXXXX")
cid=""
cleanup_container() {
  if [[ -n "$cid" ]]; then
    audit_podman rm "$cid" >/dev/null || return
    cid=""
  fi
}
cleanup() {
  local result=$?
  trap - EXIT
  if ! cleanup_container; then result=1; fi
  if ! rm -rf "$work"; then result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
root="$work/root"
mkdir -p "$root"/{proc,sys,dev,tmp,bin,usr/bin,lib64}

cid=$(audit_podman create --pull=never "$image")
audit_podman cp "$cid:/app/src/extensions/mcp-seccomp.bpf" "$work/production.bpf"
audit_podman cp "$cid:/app/src/extensions/mcp-launcher.sh" "$root/mcp-launcher.sh"
cleanup_container
# Use the image's actual loader, shell, namespace tool and dynamic libraries.
# Dereference library symlinks so this small initramfs needs no host /nix mount.
audit_podman run --rm --pull=never --network=none --entrypoint=/bin/bash "$image" -c '
set -euo pipefail
files=(/usr/bin/bwrap /bin/bash /usr/bin/unshare)
while read -r dependency; do files+=("$dependency"); done < <(ldd "${files[@]}" | awk '\''/=> \// {print $3} /^[[:space:]]*\// && $1 !~ /:$/ {print $1}'\'')
tar --dereference -cf - "${files[@]}"
' | tar -xf - -C "$root"
# bwrap forks even without a PID namespace. Observe its own child-pid metadata
# through a dedicated descriptor; the launcher's PID is not the probe PID.
# This wrapper adds only metadata collection to the unchanged image launcher.
cat > "$root/bin/bwrap" <<'SH'
#!/bin/bash
exec /usr/bin/bwrap --info-fd 4 "$@"
SH
chmod 755 "$root/bin/bwrap"

cat >"$work/load-production-seccomp.c" <<'C'
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Both arms use the same assertion. Removing only the filter must make the
 * denied-syscall assertion fail; an ENOSYS-only kernel cannot pass this proof. */
int main(int argc, char **argv) {
  long allowed, denied; int denied_errno;
  const char *arm = argc == 2 && strcmp(argv[1], "control") == 0 ? "CONTROL" : "PROBE";
  fprintf(stderr, "VM_%s_PID=%ld\n", arm, (long)getpid());
  errno = 0; allowed = syscall(SYS_getpid);
  fprintf(stderr, "VM_%s_GETPID=%ld errno=%d\n", arm, allowed, errno);
  errno = 0; denied = syscall(SYS_io_uring_setup, 0, NULL);
  denied_errno = errno;
  fprintf(stderr, "VM_%s_IO_URING=%ld errno=%d\n", arm, denied, denied_errno);
  return allowed > 0 && denied == -1 && denied_errno == ENOSYS ? 0 : 24;
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
#include <string.h>
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
static int run_arm(int filtered) {
  int status = 127; pid_t child = fork();
  if (child == 0) {
    int fd = open("/production.bpf", O_RDONLY);
    if (fd < 0 || dup2(fd, 3) < 0 || fcntl(3, F_SETFD, 0) < 0) _exit(30);
    if (fd != 3) close(fd);
    fd = open(filtered ? "/filtered-info.json" : "/control-info.json", O_CREAT | O_WRONLY | O_TRUNC, 0600);
    if (fd < 0 || dup2(fd, 4) < 0 || fcntl(4, F_SETFD, 0) < 0) _exit(32);
    if (fd != 4) close(fd);
    setenv("PATH", "/bin:/usr/bin", 1);
    setenv("EZCORP_MCP_BWRAP_ENABLED", "1", 1);
    if (filtered) setenv("EZCORP_MCP_BWRAP_SECCOMP_FD", "3", 1);
    else unsetenv("EZCORP_MCP_BWRAP_SECCOMP_FD");
    char *args[] = { "/usr/bin/unshare", "-U", "-m", "--map-root-user", "--", "/bin/bash", "/mcp-launcher.sh", "/probe-production-seccomp", filtered ? "filtered" : "control", NULL };
    execv(args[0], args); perror("launcher exec"); _exit(31);
  }
  if (child > 0) {
    printf("VM_%s_LAUNCHER_PID=%ld\n", filtered ? "PROBE" : "CONTROL", (long)child);
    fflush(stdout);
    waitpid(child, &status, 0);
  }
  char info[4096] = {0}; long reported = 0;
  int fd = open(filtered ? "/filtered-info.json" : "/control-info.json", O_RDONLY);
  if (fd >= 0) { read(fd, info, sizeof(info) - 1); close(fd); }
  const char *field = strstr(info, "\"child-pid\"");
  if (field) sscanf(field, "\"child-pid\" : %ld", &reported);
  printf("VM_%s_REPORTED_PID=%ld\n", filtered ? "PROBE" : "CONTROL", reported);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 127;
}
int main(void) {
  int console, filtered, control, bytes; char logs[65536];
  mount("proc", "/proc", "proc", 0, NULL);
  mount("sysfs", "/sys", "sysfs", 0, NULL);
  mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
  console = open("/dev/console", O_RDWR); if (console >= 0) { dup2(console, 0); dup2(console, 1); dup2(console, 2); }
  printf("VM_AUDIT_BOOTED "); show("/proc/sys/kernel/audit_enabled", "audit_enabled"); show("/proc/sys/kernel/seccomp/actions_logged", "actions_logged"); puts("");
  filtered = run_arm(1);
  control = run_arm(0);
  bytes = klogctl(3, logs, sizeof(logs) - 1);
  puts("VM_KERNEL_RECORDS_BEGIN");
  if (bytes > 0) { logs[bytes] = 0; fputs(logs, stdout); }
  puts("VM_KERNEL_RECORDS_END");
  printf("VM_PROBE_STATUS=%d\nVM_CONTROL_STATUS=%d\n", filtered, control);
  sync(); reboot(LINUX_REBOOT_CMD_POWER_OFF); return 0;
}
C
REALGCC="$real_gcc" "$compiler" -static -O2 -Wall -Wextra -o "$root/init" "$work/init.c"

mkdir -p "$(dirname "$out")"
( cd "$root" && find . -print | cpio -o -H newc ) >"$work/initramfs.cpio"
set +e
timeout --foreground --kill-after=5s 45s qemu-system-x86_64 -enable-kvm -nic none -m 512M -kernel "$kernel" -initrd "$work/initramfs.cpio" \
  -append 'console=ttyS0 audit=1 panic=-1' -display none -serial stdio -no-reboot 2>&1 | tr -d '\r' | tee "$out"
qemu_status=${PIPESTATUS[0]}
set -e
[[ $qemu_status -eq 0 ]] || { echo "qemu exit=$qemu_status" >&2; exit "$qemu_status"; }
grep -Eq 'audit: type=2000 .*audit_enabled=1' "$out"
grep -q '^VM_PROBE_GETPID=[1-9][0-9]* errno=0$' "$out"
grep -q '^VM_PROBE_IO_URING=-1 errno=38$' "$out"
grep -q '^VM_PROBE_STATUS=0$' "$out"
grep -q '^VM_CONTROL_STATUS=24$' "$out"
grep -q '^VM_CONTROL_GETPID=[1-9][0-9]* errno=0$' "$out"
if grep -q '^VM_CONTROL_IO_URING=-1 errno=38$' "$out"; then
  echo "The no-filter control also returned ENOSYS; denial cause is unproved" >&2
  exit 27
fi
pid=$(sed -n 's/^VM_PROBE_PID=\([1-9][0-9]*\)$/\1/p' "$out" | tail -n 1)
[[ -n "$pid" ]] || { echo "probe PID was not emitted" >&2; exit 25; }
reported_pid=$(sed -n 's/^VM_PROBE_REPORTED_PID=\([1-9][0-9]*\)$/\1/p' "$out" | tail -n 1)
[[ "$pid" == "$reported_pid" ]] || { echo "bwrap child PID $reported_pid differs from actual probe PID $pid" >&2; exit 28; }
awk -v pid="$pid" '
  /^VM_KERNEL_RECORDS_BEGIN$/ { window=1; next }
  /^VM_KERNEL_RECORDS_END$/ { window=0 }
  window && /audit: type=1326/ && $0 ~ (" pid=" pid " ") && / syscall=39 / && / code=0x7ffc0000( |$)/ { found=1 }
  END { exit !found }
' "$out" || { echo "no declared getpid LOG record for guest pid $pid in the captured kernel window" >&2; exit 26; }
echo "VM_AUDIT_ASSERTION=PASS pid=$pid" | tee -a "$out"
{
  printf 'VM_IMAGE_ID=%s\nVM_IMAGE_SOURCE_COMMIT_SHA=%s\n' "$image_id" "$image_source"
  printf 'VM_DRIVER_SHA256=%s\n' "$(sha256sum "$repo/scripts/shipping-audit-vm.sh" | cut -d ' ' -f 1)"
  printf 'VM_LAUNCHER_SHA256=%s\n' "$(sha256sum "$root/mcp-launcher.sh" | cut -d ' ' -f 1)"
  printf 'VM_FILTER_SHA256=%s\n' "$(sha256sum "$work/production.bpf" | cut -d ' ' -f 1)"
} | tee -a "$out"
