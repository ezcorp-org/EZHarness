#!/usr/bin/env python3
# import-map.py <repo> <base> (D4a, team-lead 2026-10-20): print, one per line, every bun test file in <repo> that DIRECTLY imports a
# source file changed in <base>..HEAD (relative specifiers: from "...", import "...", import("..."), with or without the extension,
# or a folder's index). The commit hook maps by file name only (scripts/lib/hook-lib.sh staged_test_targets), so a suite that
# only imports a changed source was never run (session 6: tests/postgres/factory-metrics-scrape.test.ts). web/ is vitest's, not bun's.
import os, re, subprocess, sys

SPEC = re.compile(r"""(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"']+)["']""")


def stem(path):
    return re.sub(r"\.(ts|tsx|js|mjs)$", "", os.path.normpath(path))


def main(repo, base):
    git = lambda *a: subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True, check=True).stdout.splitlines()
    changed = {stem(p) for p in git("diff", "--name-only", base, "HEAD")
               if re.search(r"\.(ts|tsx)$", p) and not re.search(r"\.(test|spec)\.tsx?$", p)}
    for test in sorted(git("ls-files", "*.test.ts", "*.test.tsx")):
        if test.startswith("web/") or not os.path.isfile(os.path.join(repo, test)):
            continue
        text = open(os.path.join(repo, test), encoding="utf-8").read()
        for spec in SPEC.findall(text):
            target = stem(os.path.join(os.path.dirname(test), spec))
            if target in changed or os.path.join(target, "index") in changed:
                print(test)
                break
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
