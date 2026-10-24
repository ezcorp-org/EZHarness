#!/usr/bin/env python3
# RECONSTRUCTED 2026-10-16 after systemd-tmpfiles deleted the file (w00/findings-match.py; no copy survived).
# Rebuilt from the recorded outputs (w00/w4h-merge/*/cov/origin-main-expected-match.txt, the receipts
# docs/validation/factory/wave4/*-expected-match.txt and *-findings-info.txt) and the handoff entries (2026-09-27 00:24Z
# ruling (b): exact sorted-set match, prints sha256/both sets/EXTRA/MISSING; 03:58Z third argument = leg label).
# Test: w00/findings-match.test.sh.
#
# Contract (w00/merge-commit-gates.sh): findings-match.py <gate-integrity log> <expected file> [leg label]
#   The log is one run of `bun scripts/gate-integrity.ts` WITHOUT GATE_CHANGE_APPROVED. Its findings are the indented lines
#   of the "Gate integrity FAILED (N finding(s)):" block; each finding's path is the text between the first ": " and the
#   first " — " (a rename keeps its "old → new"). The expected file lists one path per line (blank lines ignored).
#   Output (four lines, then EXTRA/MISSING only when they are non-empty):
#     expected file <path> sha256 <sha256 of the file>
#     found:    <sorted paths joined by " | ">
#     expected: <sorted paths joined by " | ">
#     EXTRA (new gate change): <found - expected>
#     MISSING (tree no longer matches the ruling): <expected - found>
#     <label> leg: PASS (findings equal the expected integ set)   |   <label> leg: FAIL
#   Label default "origin/main"; merge-commit-gates.sh passes "base" for the base leg. Exit 0 on PASS, 1 on FAIL.
#   A log of an approved run ("BYPASSED via GATE_CHANGE_APPROVED") is not an unapproved leg: it FAILS (the 00:24Z
#   self-test "all-bypassed log FAIL"); the BYPASSED line below is inferred wording.
import hashlib, re, sys


def findings(text):
    found, in_block, bypassed = [], False, False
    for line in text.splitlines():
        if "BYPASSED via GATE_CHANGE_APPROVED" in line:
            bypassed = True
        if re.match(r"^Gate integrity FAILED \(\d+ finding\(s\)\):", line):
            in_block = True
            continue
        if in_block:
            if not line.startswith("  ") or not line.strip():
                in_block = False
                continue
            head = line.strip().split(" — ", 1)[0]
            found.append(head.split(": ", 1)[1] if ": " in head else head)
    return sorted(set(found)), bypassed


def main(argv):
    if len(argv) not in (2, 3):
        print("usage: findings-match.py <gate-integrity log> <expected file> [leg label]", file=sys.stderr)
        return 64
    log, expected_path, label = argv[0], argv[1], (argv[2] if len(argv) == 3 else "origin/main")
    with open(expected_path, "rb") as f:
        raw = f.read()
    expected = sorted({l.strip() for l in raw.decode(errors="replace").splitlines() if l.strip()})
    with open(log, errors="replace") as f:
        found, bypassed = findings(f.read())
    print(f"expected file {expected_path} sha256 {hashlib.sha256(raw).hexdigest()}")
    print("found:    " + " | ".join(found))
    print("expected: " + " | ".join(expected))
    extra = [p for p in found if p not in expected]
    missing = [p for p in expected if p not in found]
    if extra:
        print("EXTRA (new gate change): " + " | ".join(extra))
    if missing:
        print("MISSING (tree no longer matches the ruling): " + " | ".join(missing))
    if bypassed:
        print("BYPASSED run (GATE_CHANGE_APPROVED was set): not an unapproved leg")
    if extra or missing or bypassed:
        print(f"{label} leg: FAIL")
        return 1
    print(f"{label} leg: PASS (findings equal the expected integ set)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
