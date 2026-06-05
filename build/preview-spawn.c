/*
 * preview-spawn.c — Secure User-Site Preview / Port Exposure, Phase 3a/3b
 * (uid-based portable isolation — see tasks/preview-port-exposure.md
 * "Phase 3 REDESIGN — portable uid-based isolation").
 *
 * A TINY, auditable setuid-root helper with TWO modes. The non-root app
 * (uid 1000) invokes it to launch — and later KILL — untrusted dev servers
 * running as a per-conversation "preview uid" drawn from an allowlisted
 * range. Installed root:root mode 4755 (see the Dockerfile build stage), so
 * when uid 1000 execs it the process gains euid=0 — verified on this host
 * with NO container posture change (root mount is not nosuid, NoNewPrivs=0).
 *
 * ── SPAWN mode: `preview-spawn <uid> <workdir> <cmd> [args...]` ──
 * What it does, in order (fail-closed at every step):
 *   1. Validate argv shape: at least `preview-spawn <uid> <workdir> <cmd>`.
 *   2. Parse + range-check the target uid against [PREVIEW_UID_MIN,
 *      PREVIEW_UID_MAX]. Anything outside the preview range — including
 *      0 (root), the app uid, negatives, non-integers — is REFUSED. This
 *      is the keystone: the helper can ONLY ever drop to a preview uid,
 *      never escalate to or stay as root, and never become the app uid
 *      (which owns .ezcorp/data).
 *   3. setgid(uid) + setgroups(0, NULL) — drop ALL supplementary groups
 *      (so the preview uid can't inherit the app user's group access to
 *      .ezcorp/data) and set the primary gid to the same numeric id.
 *   4. setuid(uid) — drop to the preview uid. After this euid==ruid==uid
 *      and there is NO path back to root (we verify the drop took).
 *   5. setsid() — become a process-group + session leader so the whole
 *      dev-server tree shares one pgid and can be reaped with a single
 *      group signal (see --kill below). Best-effort: if setsid fails
 *      because we're already a group leader, proceed.
 *   6. chdir(workdir) — the caller-provided conversation work dir.
 *   7. Build a RESTRICTED env (PATH/HOME/preview metadata only) — never
 *      forward the parent's secret-bearing environment.
 *   8. execvp(cmd, argv+...) — replace the process image with the dev
 *      server. No shell is ever invoked (no system()/sh -c), so there is
 *      no shell-injection surface; args are passed through verbatim.
 *
 * ── KILL mode: `preview-spawn --kill <uid> <pgid>` ──
 * The reaper cannot signal a preview-uid process as the app uid (kill(2)
 * → EPERM across uids), so it routes through this setuid-root mode. The
 * helper, running euid=0:
 *   1. Validates argv shape (exactly `--kill <uid> <pgid>`).
 *   2. Range-checks <uid> against the SAME preview allowlist as spawn —
 *      it can NEVER target root / the app uid / an out-of-range uid.
 *   3. Parses <pgid> as a plain positive integer.
 *   4. OWNERSHIP CHECK: reads /proc/<pgid>/status and refuses unless the
 *      leader process's real Uid matches <uid>. This stops the helper from
 *      becoming a root-kill-anything primitive: it can only ever signal a
 *      process group whose leader is genuinely owned by the named preview
 *      uid. (A process group's id IS its leader's pid.)
 *   5. Sends SIGTERM to the whole group (kill(-pgid, SIGTERM)); waits a
 *      brief grace; if any group member survives, escalates to SIGKILL.
 *   6. Exits 0 once the group is gone (or was already gone), non-zero on a
 *      validation/permission failure. No shell, no exec.
 *
 * Defensive posture: no dynamic allocation of attacker-controlled length,
 * no format strings on attacker input, every syscall return checked,
 * exits non-zero (and never execs/signals) on any failure.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <grp.h>
#include <signal.h>
#include <time.h>
#include <sys/types.h>

/*
 * The allowlisted preview-uid range. MUST match PREVIEW_UID_MIN/MAX in
 * src/runtime/preview/preview-spawn.ts (the TS side validates the same
 * window before ever shelling out; this is the in-helper backstop so the
 * boundary holds even if the helper is invoked directly). 90000–99000 is
 * comfortably above the app uid (1000) and any normal system account.
 */
#define PREVIEW_UID_MIN 90000
#define PREVIEW_UID_MAX 99000

/* Restricted PATH handed to the dev server — no caller-controlled dirs. */
#define PREVIEW_PATH "/usr/local/bin:/usr/bin:/bin"

static int fail(const char *msg) {
    /* Single defensive error sink: write to stderr, return EXIT_FAILURE.
     * Never reveals more than the stage that refused. */
    fprintf(stderr, "preview-spawn: %s\n", msg);
    return EXIT_FAILURE;
}

/*
 * Parse a base-10 uid from `s` into `*out`. Returns 0 on success, -1 on
 * any malformed input (empty, non-digit, overflow, trailing garbage).
 * Strictly digits-only: no sign, no whitespace, no 0x — a preview uid is
 * always a plain positive integer.
 */
static int parse_uid(const char *s, long *out) {
    if (s == NULL || s[0] == '\0') return -1;
    for (const char *p = s; *p; p++) {
        if (*p < '0' || *p > '9') return -1;
    }
    errno = 0;
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (errno != 0 || end == NULL || *end != '\0') return -1;
    *out = v;
    return 0;
}

/*
 * Read the real Uid of process `pid` from /proc/<pid>/status. Returns 0 on
 * success (writing into *out), -1 on any failure (no such process, unreadable
 * status, malformed line). The `Uid:` line is `Uid:\t<real>\t<eff>\t...`; we
 * take the FIRST field (real uid). Fixed-size buffers, no attacker-length
 * allocation. Used by kill mode to prove the target group leader is genuinely
 * owned by the named preview uid before signaling.
 */
static int read_proc_uid(long pid, long *out) {
    char path[64];
    int n = snprintf(path, sizeof(path), "/proc/%ld/status", pid);
    if (n <= 0 || (size_t)n >= sizeof(path)) return -1;
    FILE *f = fopen(path, "r");
    if (f == NULL) return -1;
    char line[256];
    int found = -1;
    while (fgets(line, sizeof(line), f) != NULL) {
        if (strncmp(line, "Uid:", 4) == 0) {
            long ruid = -1;
            /* Uid:\t<real>\t<eff>\t<saved>\t<fs> — read only the real uid. */
            if (sscanf(line + 4, "%ld", &ruid) == 1) {
                *out = ruid;
                found = 0;
            }
            break;
        }
    }
    fclose(f);
    return found;
}

/*
 * KILL mode — `preview-spawn --kill <uid> <pgid>`. Running euid=0 (setuid),
 * signal the process GROUP `pgid` whose leader is owned by preview uid `uid`.
 * Fail-closed: refuses an out-of-range uid, a non-integer pgid, or a target
 * whose leader is NOT owned by `uid` (so it can never become a kill-anything
 * primitive). SIGTERM, brief grace, then SIGKILL for survivors.
 */
static int run_kill_mode(int argc, char **argv) {
    /* Exactly: --kill <uid> <pgid> */
    if (argc != 4) {
        return fail("usage: preview-spawn --kill <uid> <pgid>");
    }

    long uid = 0;
    if (parse_uid(argv[2], &uid) != 0) {
        return fail("kill: target uid is not a plain positive integer");
    }
    if (uid < PREVIEW_UID_MIN || uid > PREVIEW_UID_MAX) {
        return fail("kill: target uid outside the allowlisted preview range");
    }

    long pgid = 0;
    if (parse_uid(argv[3], &pgid) != 0) {
        return fail("kill: pgid is not a plain positive integer");
    }
    /* A pgid is its leader's pid; reject 0/1 (whole-session / init) outright. */
    if (pgid <= 1) {
        return fail("kill: refusing pgid <= 1");
    }

    /* OWNERSHIP CHECK — the group leader (pid == pgid) MUST be owned by the
     * named preview uid. This is what stops kill mode from signaling
     * arbitrary processes: a root-running setuid helper that would kill any
     * pid is a privilege-escalation primitive; we only ever signal a group
     * whose leader is genuinely a preview uid. */
    long leader_uid = -1;
    if (read_proc_uid(pgid, &leader_uid) != 0) {
        /* No such process / unreadable — treat as already gone (success):
         * the reaper's goal (the tree is not running as this uid) holds. */
        return EXIT_SUCCESS;
    }
    if (leader_uid != uid) {
        return fail("kill: target pgid leader is not owned by the named preview uid");
    }

    /* Signal the whole group: kill(-pgid, sig). SIGTERM first for a clean
     * shutdown. ESRCH (already gone) is success. */
    if (kill((pid_t)(-pgid), SIGTERM) != 0 && errno != ESRCH) {
        return fail("kill: SIGTERM to process group failed");
    }

    /* Brief grace, then check the leader. If it's gone, the group is reaped. */
    struct timespec grace = { .tv_sec = 0, .tv_nsec = 300L * 1000L * 1000L };
    nanosleep(&grace, NULL);

    long still = -1;
    if (read_proc_uid(pgid, &still) != 0) {
        /* Leader gone → success. */
        return EXIT_SUCCESS;
    }
    /* Leader survived SIGTERM — escalate to SIGKILL on the group. */
    if (kill((pid_t)(-pgid), SIGKILL) != 0 && errno != ESRCH) {
        return fail("kill: SIGKILL to process group failed");
    }
    return EXIT_SUCCESS;
}

int main(int argc, char **argv) {
    /* Kill mode dispatch — `preview-spawn --kill <uid> <pgid>`. */
    if (argc >= 2 && strcmp(argv[1], "--kill") == 0) {
        return run_kill_mode(argc, argv);
    }

    /* 1. argv shape: preview-spawn <uid> <workdir> <cmd> [args...] */
    if (argc < 4) {
        return fail("usage: preview-spawn <uid> <workdir> <cmd> [args...]");
    }

    /* 2. uid range allowlist — the keystone. */
    long uid = 0;
    if (parse_uid(argv[1], &uid) != 0) {
        return fail("target uid is not a plain positive integer");
    }
    if (uid < PREVIEW_UID_MIN || uid > PREVIEW_UID_MAX) {
        return fail("target uid outside the allowlisted preview range");
    }

    const char *workdir = argv[2];
    if (workdir == NULL || workdir[0] != '/') {
        /* Require an ABSOLUTE workdir — a relative path would resolve
         * against the helper's cwd, which is attacker-influenced. */
        return fail("workdir must be an absolute path");
    }

    /* 3. Drop ALL supplementary groups + set primary gid to the uid.
     * setgroups MUST happen while still privileged (before setuid). */
    if (setgroups(0, NULL) != 0) {
        return fail("setgroups(0) failed");
    }
    if (setgid((gid_t)uid) != 0) {
        return fail("setgid failed");
    }

    /* 4. Drop to the preview uid — irreversibly. */
    if (setuid((uid_t)uid) != 0) {
        return fail("setuid failed");
    }
    /* Verify the drop actually took (defense against a setuid that
     * silently no-ops). If we could regain root, refuse to exec. */
    if (setuid(0) == 0) {
        return fail("privilege drop did not stick — refusing to exec");
    }
    if (getuid() != (uid_t)uid || geteuid() != (uid_t)uid) {
        return fail("uid mismatch after drop");
    }

    /* 5. Become a process-group + session leader so the entire dev-server
     * tree shares ONE pgid and the reaper can take it down with a single
     * group signal (kill(-pgid, …) in --kill mode). setsid fails with EPERM
     * if we are ALREADY a group leader — that's fine (we're still a leader),
     * so we proceed regardless; we only log nothing (no stderr noise on the
     * happy path). The pgid the reaper records is this process's pid. */
    if (setsid() == (pid_t)-1) {
        /* Already a group leader (EPERM) is acceptable — the caller can still
         * signal our pgid. Any other failure is non-fatal too: at worst the
         * reaper signals a smaller group. Do not abort the spawn. */
    }

    /* 6. Enter the conversation work dir. */
    if (chdir(workdir) != 0) {
        return fail("chdir to workdir failed");
    }

    /* 7. Restricted env. We deliberately discard the parent environment
     * (which may carry DB creds / JWT secret) and hand the child only a
     * minimal, known-safe set. HOME points at the workdir so tools that
     * write dotfiles stay inside the jail. */
    if (clearenv() != 0) {
        return fail("clearenv failed");
    }
    if (setenv("PATH", PREVIEW_PATH, 1) != 0 ||
        setenv("HOME", workdir, 1) != 0 ||
        setenv("PWD", workdir, 1) != 0 ||
        setenv("EZCORP_PREVIEW", "1", 1) != 0) {
        return fail("setenv failed");
    }

    /* 8. exec the dev server. argv[3..] is cmd + its args, passed verbatim
     * — NO shell, so nothing is re-interpreted. */
    execvp(argv[3], &argv[3]);
    /* Only reached if exec failed. */
    return fail("execvp failed");
}
