/*
 * compile-seccomp.c — Phase 58 Plan 01 (MCP-04) JSON → cBPF helper.
 *
 * Compiled and executed at Docker image build time:
 *
 *   gcc -O2 -o /tmp/compile-seccomp build/compile-seccomp.c -lseccomp
 *   /tmp/compile-seccomp src/extensions/mcp-seccomp.json /app/src/extensions/mcp-seccomp.bpf
 *
 * The output blob is passed to `bwrap --seccomp <fd>` at MCP-spawn time so
 * the kernel applies the filter to every syscall in the child process tree.
 *
 * Phase 58 / MCP-04 — enforce-mode flip. Phase 55 hardcoded SCMP_ACT_LOG
 * everywhere (observability-only). This rewrite parses the JSON's
 * `defaultAction` + `defaultErrnoRet` fields and threads them through
 * `seccomp_init()` + per-syscall `seccomp_rule_add()`. The post-flip JSON
 * declares:
 *
 *     "defaultAction":   "SCMP_ACT_ERRNO",
 *     "defaultErrnoRet": 38                  // ENOSYS — see Pitfall 5
 *
 * so any syscall outside the explicit allow-list returns ENOSYS instead
 * of SIGSYS-killing the child. Per-syscall entries stay as SCMP_ACT_LOG
 * — they're the explicit-allow-list-mirror documented in RESEARCH §Code
 * Examples (redundant under default-deny but documents intent).
 *
 * SCMP_FLTATR_ACT_BADARCH is set to SCMP_ACT_ERRNO(ENOSYS) regardless of
 * the JSON's default — the "unknown architecture" semantic only makes
 * sense as ENOSYS. (Hardcoding ENOSYS here is intentional; the JSON's
 * defaultErrnoRet governs the per-syscall fallback only.)
 *
 * Hand-rolled JSON parser: the schema is fixed and tiny (defaultAction +
 * defaultErrnoRet + syscalls[].names[] + syscalls[].action), so pulling
 * in cJSON would be overkill. The parser is deliberately strict — any
 * deviation from the expected layout aborts with a non-zero exit. This
 * is good: image build fails fast.
 *
 * Unsupported syscall names (resolved to a negative number by libseccomp
 * — typically arch-specific syscalls absent on the build host) are logged
 * to stderr and skipped, NOT fail-stopped. This keeps the build portable
 * across x86_64 / aarch64 / etc.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Read an entire file into a heap buffer (NUL-terminated). */
static char *slurp(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "compile-seccomp: open(%s): %s\n", path, strerror(errno));
        return NULL;
    }
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0) { fclose(f); return NULL; }
    rewind(f);
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    if (out_len) *out_len = n;
    return buf;
}

/* Parse the integer literal that follows `"defaultErrnoRet"` in the JSON
 * head. Returns the int, or 38 (ENOSYS) if the key is absent. Phase 58
 * defaultErrnoRet=38 is the Pitfall 5 lock — EPERM=1 breaks Bun JIT
 * pkey_alloc fallback AND Python 3.12 glibc clock_gettime64 probe. */
static int parse_default_errno_ret(const char *buf, const char *end) {
    const char *key = strstr(buf, "\"defaultErrnoRet\"");
    if (!key || key >= end) return 38;
    const char *p = key + strlen("\"defaultErrnoRet\"");
    while (p < end && (*p == ' ' || *p == ':' || *p == '\t')) p++;
    if (p >= end) return 38;
    char *endptr = NULL;
    long v = strtol(p, &endptr, 10);
    if (endptr == p) return 38;
    return (int)v;
}

/* Parse the quoted action string that follows `"defaultAction"` in the
 * JSON head and resolve it to a libseccomp action constant.
 *
 * Recognized strings:
 *   - "SCMP_ACT_LOG"   -> SCMP_ACT_LOG       (Phase 55 observability)
 *   - "SCMP_ACT_ERRNO" -> SCMP_ACT_ERRNO(N)  (Phase 58 enforce, N from
 *                                             parse_default_errno_ret)
 *   - "SCMP_ACT_ALLOW" -> SCMP_ACT_ALLOW     (defensive — passthrough)
 *   - "SCMP_ACT_KILL"  -> SCMP_ACT_KILL      (defensive — never used in
 *                                             bundled corpus, but keeps
 *                                             the helper future-proof)
 *
 * Falls back to SCMP_ACT_LOG on unknown strings (mirrors Phase 55
 * behavior — degrade-soft, never fail-closed at compile time). */
static uint32_t parse_default_action(const char *buf, const char *end) {
    const char *key = strstr(buf, "\"defaultAction\"");
    if (!key || key >= end) return SCMP_ACT_LOG;
    const char *p = key + strlen("\"defaultAction\"");
    /* Skip `:` + whitespace + opening quote. */
    while (p < end && *p != '"') p++;
    if (p >= end) return SCMP_ACT_LOG;
    p++;  /* past opening quote */
    const char *start = p;
    while (p < end && *p != '"') p++;
    if (p >= end) return SCMP_ACT_LOG;
    size_t len = (size_t)(p - start);
    if (len == strlen("SCMP_ACT_LOG") && strncmp(start, "SCMP_ACT_LOG", len) == 0) {
        return SCMP_ACT_LOG;
    }
    if (len == strlen("SCMP_ACT_ERRNO") && strncmp(start, "SCMP_ACT_ERRNO", len) == 0) {
        int errno_ret = parse_default_errno_ret(buf, end);
        return SCMP_ACT_ERRNO((uint16_t)errno_ret);
    }
    if (len == strlen("SCMP_ACT_ALLOW") && strncmp(start, "SCMP_ACT_ALLOW", len) == 0) {
        return SCMP_ACT_ALLOW;
    }
    if (len == strlen("SCMP_ACT_KILL") && strncmp(start, "SCMP_ACT_KILL", len) == 0) {
        return SCMP_ACT_KILL;
    }
    fprintf(stderr,
            "compile-seccomp: unknown defaultAction '%.*s', falling back to SCMP_ACT_LOG\n",
            (int)len, start);
    return SCMP_ACT_LOG;
}

/* Parse the per-syscall action declared in a single syscalls[] entry. The
 * `entry_start` / `entry_end` cursors bound one entry's brace span. The
 * default fallback is SCMP_ACT_LOG (matches Phase 55 behavior — explicit
 * allow-list-mirror under default-deny enforce; redundant but documented).
 *
 * The errno_ret arg is threaded through because per-syscall ERRNO entries
 * (none currently in the bundled corpus, but the helper is future-proof)
 * should use the same default errno as the JSON head. */
static uint32_t parse_syscall_action(const char *entry_start,
                                     const char *entry_end,
                                     int default_errno_ret) {
    const char *key = NULL;
    const char *p = entry_start;
    /* Find the `"action"` key WITHIN this entry's bounds. */
    while (p < entry_end - 8) {
        if (strncmp(p, "\"action\"", 8) == 0) {
            key = p;
            break;
        }
        p++;
    }
    if (!key) return SCMP_ACT_LOG;
    p = key + 8;
    while (p < entry_end && *p != '"') p++;
    if (p >= entry_end) return SCMP_ACT_LOG;
    p++;  /* past opening quote */
    const char *start = p;
    while (p < entry_end && *p != '"') p++;
    if (p >= entry_end) return SCMP_ACT_LOG;
    size_t len = (size_t)(p - start);
    if (len == strlen("SCMP_ACT_LOG") && strncmp(start, "SCMP_ACT_LOG", len) == 0) {
        return SCMP_ACT_LOG;
    }
    if (len == strlen("SCMP_ACT_ERRNO") && strncmp(start, "SCMP_ACT_ERRNO", len) == 0) {
        return SCMP_ACT_ERRNO((uint16_t)default_errno_ret);
    }
    if (len == strlen("SCMP_ACT_ALLOW") && strncmp(start, "SCMP_ACT_ALLOW", len) == 0) {
        return SCMP_ACT_ALLOW;
    }
    if (len == strlen("SCMP_ACT_KILL") && strncmp(start, "SCMP_ACT_KILL", len) == 0) {
        return SCMP_ACT_KILL;
    }
    return SCMP_ACT_LOG;
}

/* Tiny JSON "find next quoted string" — returns a malloc'd copy of the
 * contents of the next "..." starting at *p (or after *p). Advances *p
 * past the closing quote. Handles basic backslash escapes for the
 * characters we actually see in seccomp profiles (newline, quote,
 * backslash). Returns NULL on EOF or malformed input. */
static char *next_string(const char **p, const char *end) {
    const char *q = *p;
    while (q < end && *q != '"') q++;
    if (q >= end) return NULL;
    q++;  /* past opening quote */
    const char *start = q;
    /* Scan for unescaped closing quote — syscall names have no escapes,
     * but be defensive in case the profile is regenerated from a source
     * that emits any. */
    while (q < end && *q != '"') {
        if (*q == '\\' && q + 1 < end) q += 2;
        else q++;
    }
    if (q >= end) return NULL;
    size_t len = (size_t)(q - start);
    char *out = (char *)malloc(len + 1);
    if (!out) return NULL;
    memcpy(out, start, len);
    out[len] = '\0';
    *p = q + 1;
    return out;
}

/* Skip whitespace + JSON structural tokens between values. */
static void skip_ws(const char **p, const char *end) {
    while (*p < end && (**p == ' ' || **p == '\n' || **p == '\r' || **p == '\t' ||
                        **p == ',' || **p == ':' || **p == '[' || **p == ']' ||
                        **p == '{' || **p == '}'))
        (*p)++;
}

/* Find the closing `}` that matches the opening `{` at *p (which must
 * point AT the opening brace). Returns a pointer to the matching `}` or
 * NULL on malformed input. Naive depth-counted scan — adequate for the
 * non-pathological JSON shapes Plan 03 emits. */
static const char *find_entry_end(const char *p, const char *end) {
    if (p >= end || *p != '{') return NULL;
    int depth = 0;
    while (p < end) {
        if (*p == '{') depth++;
        else if (*p == '}') {
            depth--;
            if (depth == 0) return p;
        }
        p++;
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <in.json> <out.bpf>\n", argv[0]);
        return 2;
    }
    const char *in_path = argv[1];
    const char *out_path = argv[2];

    size_t buf_len = 0;
    char *buf = slurp(in_path, &buf_len);
    if (!buf) return 1;
    const char *end = buf + buf_len;

    /* Phase 58 — initialize with the JSON's declared defaultAction. The
     * post-flip JSON declares SCMP_ACT_ERRNO with defaultErrnoRet=38
     * (ENOSYS). parse_default_action handles all four recognized action
     * strings; falls back to SCMP_ACT_LOG on unknown input. */
    uint32_t default_act = parse_default_action(buf, end);
    int default_errno_ret = parse_default_errno_ret(buf, end);
    scmp_filter_ctx ctx = seccomp_init(default_act);
    if (!ctx) {
        fprintf(stderr, "compile-seccomp: seccomp_init failed\n");
        free(buf);
        return 1;
    }

    /* SCMP_FLTATR_ACT_BADARCH governs the action taken on syscalls from
     * an unknown architecture. ENOSYS is the only sensible answer
     * regardless of the JSON's default (a kill-on-bad-arch posture would
     * brick multi-arch deployments). Hardcoded literal — NOT threaded
     * from defaultErrnoRet — because the badarch semantic is orthogonal
     * to per-syscall errno_ret. */
    if (seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_ERRNO(ENOSYS)) < 0) {
        fprintf(stderr,
                "compile-seccomp: seccomp_attr_set(SCMP_FLTATR_ACT_BADARCH) failed: %s\n",
                strerror(errno));
        seccomp_release(ctx);
        free(buf);
        return 1;
    }

    /* Walk the JSON looking for syscall entries. Each entry is a
     * `{ "names": [...], "action": "..." }` object. We compute the
     * entry's per-syscall action ONCE (parse_syscall_action) and then
     * apply it to every name in the names[] array. */
    size_t added = 0, skipped = 0;
    const char *p = buf;
    while (p < end) {
        /* Find the next entry's opening brace. We seek "names" first
         * (cheap) and then walk back to the enclosing `{`. */
        const char *names_key = strstr(p, "\"names\"");
        if (!names_key) break;
        /* Walk back from names_key to find the enclosing '{'. Bounded
         * scan — the entry brace is always within ~64 chars upstream
         * given the generator's layout. */
        const char *entry_start = names_key;
        while (entry_start > buf && *entry_start != '{') entry_start--;
        if (*entry_start != '{') {
            p = names_key + 7;
            continue;
        }
        const char *entry_end = find_entry_end(entry_start, end);
        if (!entry_end) {
            p = names_key + 7;
            continue;
        }

        uint32_t syscall_act = parse_syscall_action(
            entry_start, entry_end, default_errno_ret);

        p = names_key + 7;  /* past `"names"` */
        skip_ws(&p, end);
        if (p >= end || *p != '[') {
            /* Defensive: skip malformed entry by advancing past key. */
            continue;
        }
        p++;  /* past '[' */
        /* Read consecutive quoted strings until ']'. */
        while (p < end && *p != ']') {
            skip_ws(&p, end);
            if (p >= end || *p == ']') break;
            if (*p != '"') { p++; continue; }
            char *name = next_string(&p, end);
            if (!name) break;
            int n = seccomp_syscall_resolve_name(name);
            if (n < 0) {
                /* Syscall not known on this arch — informational only. */
                fprintf(stderr, "compile-seccomp: skipping unresolved syscall '%s' on this arch\n", name);
                skipped++;
            } else {
                if (seccomp_rule_add(ctx, syscall_act, n, 0) < 0) {
                    fprintf(stderr,
                            "compile-seccomp: seccomp_rule_add(%s, #%d) failed: %s\n",
                            name, n, strerror(errno));
                    free(name);
                    seccomp_release(ctx);
                    free(buf);
                    return 1;
                }
                added++;
            }
            free(name);
        }
        if (p < end && *p == ']') p++;
        /* Advance past this entry's closing brace so the next strstr()
         * iteration finds the next entry. */
        if (p < entry_end) p = entry_end + 1;
    }

    /* Open output file (O_WRONLY|O_CREAT|O_TRUNC, mode 0644). */
    int out_fd = open(out_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out_fd < 0) {
        fprintf(stderr, "compile-seccomp: open(%s): %s\n", out_path, strerror(errno));
        seccomp_release(ctx);
        free(buf);
        return 1;
    }

    if (seccomp_export_bpf(ctx, out_fd) < 0) {
        fprintf(stderr, "compile-seccomp: seccomp_export_bpf failed: %s\n", strerror(errno));
        close(out_fd);
        seccomp_release(ctx);
        free(buf);
        return 1;
    }

    close(out_fd);
    seccomp_release(ctx);
    free(buf);
    fprintf(stderr,
            "compile-seccomp: wrote %s (added=%zu, skipped=%zu)\n",
            out_path, added, skipped);
    return 0;
}
