/*
 * preview-spawn.c — Secure User-Site Preview / Port Exposure, Phase 3a
 * (uid-based portable isolation — see tasks/preview-port-exposure.md
 * "Phase 3 REDESIGN — portable uid-based isolation").
 *
 * A TINY, auditable setuid-root helper. The non-root app (uid 1000)
 * invokes it to launch an untrusted dev server as a per-conversation
 * "preview uid" drawn from an allowlisted range. Installed root:root mode
 * 4755 (see the Dockerfile build stage), so when uid 1000 execs it the
 * process gains euid=0 — verified on this host with NO container posture
 * change (root mount is not nosuid, NoNewPrivs=0).
 *
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
 *   5. chdir(workdir) — the caller-provided conversation work dir.
 *   6. Build a RESTRICTED env (PATH/HOME/preview metadata only) — never
 *      forward the parent's secret-bearing environment.
 *   7. execvp(cmd, argv+...) — replace the process image with the dev
 *      server. No shell is ever invoked (no system()/sh -c), so there is
 *      no shell-injection surface; args are passed through verbatim.
 *
 * Defensive posture: no dynamic allocation of attacker-controlled length,
 * no format strings on attacker input, every syscall return checked,
 * exits non-zero (and never execs) on any failure.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <grp.h>
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

int main(int argc, char **argv) {
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

    /* 5. Enter the conversation work dir. */
    if (chdir(workdir) != 0) {
        return fail("chdir to workdir failed");
    }

    /* 6. Restricted env. We deliberately discard the parent environment
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

    /* 7. exec the dev server. argv[3..] is cmd + its args, passed verbatim
     * — NO shell, so nothing is re-interpreted. */
    execvp(argv[3], &argv[3]);
    /* Only reached if exec failed. */
    return fail("execvp failed");
}
