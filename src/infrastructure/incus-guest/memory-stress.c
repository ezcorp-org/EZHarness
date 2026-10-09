#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>

#define CONTROL_CEILING (1024u * 1024u)
static int space(char c) { return c == ' ' || c == '\t'; }
static unsigned long kilobytes(const char *line, const char *key) {
  size_t n = strlen(key);
  if (strncmp(line, key, n))
    return ULONG_MAX;
  const char *p = line + n;
  while (space(*p))
    p++;
  if (*p < '0' || *p > '9')
    return ULONG_MAX;
  errno = 0;
  char *end;
  unsigned long value = strtoul(p, &end, 10);
  if (errno || value > ULONG_MAX / 1024 || !space(*end))
    return ULONG_MAX;
  while (space(*end))
    end++;
  return strcmp(end, "kB\n") == 0 ? value * 1024 : ULONG_MAX;
}
static int span(const char *line, unsigned long *begin, unsigned long *end) {
  if (!strchr("0123456789abcdef", *line) || !*line)
    return 0;
  char *p;
  errno = 0;
  unsigned long a = strtoul(line, &p, 16);
  if (errno || *p != '-')
    return 0;
  const char *q = p + 1;
  if (!*q || !strchr("0123456789abcdef", *q))
    return 0;
  unsigned long b = strtoul(q, &p, 16);
  if (errno || !space(*p) || b < a)
    return 0;
  *begin = a;
  *end = b;
  return 1;
}
static unsigned long locked_bytes(void) {
  FILE *f = fopen("/proc/self/status", "r");
  char line[256];
  if (!f)
    return ULONG_MAX;
  while (fgets(line, sizeof line, f))
    if (!strncmp(line, "VmLck:", 6)) {
      unsigned long value = kilobytes(line, "VmLck:");
      fclose(f);
      return value;
    }
  fclose(f);
  return ULONG_MAX;
}
static unsigned long mapped_bytes(void) {
  FILE *f = fopen("/proc/self/maps", "r");
  char line[1024];
  unsigned long begin, end, total = 0;
  if (!f)
    return ULONG_MAX;
  while (fgets(line, sizeof line, f)) {
    if (!strchr(line, '\n') || !span(line, &begin, &end) ||
        end - begin > ULONG_MAX - total) {
      fclose(f);
      return ULONG_MAX;
    }
    total += end - begin;
  }
  fclose(f);
  return total;
}
static unsigned long payload_locked(const void *address, size_t size) {
  FILE *f = fopen("/proc/self/smaps", "r");
  char line[1024];
  unsigned long a, b;
  int selected = 0;
  uintptr_t begin = (uintptr_t)address;
  if (size > UINTPTR_MAX - begin || !f)
    return ULONG_MAX;
  while (fgets(line, sizeof line, f)) {
    if (!strchr(line, '\n')) {
      fclose(f);
      return ULONG_MAX;
    }
    if (span(line, &a, &b))
      selected = a <= begin && b >= begin + size;
    else if (selected && !strncmp(line, "Locked:", 7)) {
      unsigned long value = kilobytes(line, "Locked:");
      fclose(f);
      return value;
    }
  }
  fclose(f);
  return ULONG_MAX;
}
static int fail(const char *phase) {
  fprintf(stderr, "{\"phase\":\"%s\",\"errno\":%d}\n", phase, errno);
  return 2;
}
int main(int argc, char **argv) {
  if (argc != 2)
    return fail("arguments");
  if (!*argv[1] || strspn(argv[1], "0123456789") != strlen(argv[1]))
    return fail("target");
  char *end;
  errno = 0;
  uintmax_t target = strtoumax(argv[1], &end, 10);
  if (errno || !*argv[1] || *end || target == 0 || target > SIZE_MAX ||
      target > UINT64_C(68719476736))
    return fail("target");
  long page = sysconf(_SC_PAGESIZE);
  if (page <= 0)
    return fail("page");
  volatile unsigned char stack[16384];
  for (size_t n = 0; n < sizeof stack; n += (size_t)page)
    stack[n] = 1;
  struct rlimit limit;
  if (getrlimit(RLIMIT_MEMLOCK, &limit))
    return fail("rlimit");
  unsigned long mapped = mapped_bytes();
  if (mapped == ULONG_MAX || mapped > CONTROL_CEILING)
    return fail("control-footprint");
  FILE *score = fopen("/proc/self/oom_score_adj", "w");
  if (!score)
    return fail("score");
  if (fputs("500", score) < 0 || fclose(score))
    return fail("score");
#ifndef TEST_UNLOCKED
  if (mapped > limit.rlim_cur || mlockall(MCL_CURRENT))
    return fail("lock");
#endif
  unsigned long locked = locked_bytes();
  if (locked == ULONG_MAX || locked > CONTROL_CEILING)
    return fail("locked-footprint");
#ifndef TEST_UNLOCKED
  if (!locked)
    return fail("lock-proof");
#endif
  printf("{\"phase\":\"control\",\"mappedBytes\":%lu,\"lockedBytes\":%lu,"
         "\"pageBytes\":%ld,\"targetBytes\":%ju}\n",
         mapped, locked, page, target);
  fflush(stdout);
  volatile unsigned char *p = mmap(NULL, (size_t)target, PROT_READ | PROT_WRITE,
                                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED)
    return fail("mmap");
  unsigned long payload_lock = payload_locked((const void *)p, (size_t)target);
  if (payload_lock != 0 || locked_bytes() != locked)
    return fail("payload-unlocked-proof");
  printf("{\"phase\":\"mapped\",\"address\":\"%p\",\"lockedBytes\":%lu,"
         "\"payloadLockedBytes\":%lu}\n",
         (void *)p, locked, payload_lock);
  fflush(stdout);
  for (size_t n = 0; n < (size_t)target; n += (size_t)page)
    p[n] = 1;
  if (locked_bytes() != locked)
    return fail("payload-lock-drift");
  printf("{\"phase\":\"touched\",\"lockedBytes\":%lu}\n", locked);
  fflush(stdout);
  sleep(1);
  if (munmap((void *)p, (size_t)target))
    return fail("munmap");
  return stack[0] == 1 ? 0 : 2;
}
