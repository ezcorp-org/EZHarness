# merge-identity-lib.sh (sourced; integrator-5, 2026-10-17; team-lead's ruling R1 after the W4H-32 re-merge try1): the IDENTITY step of a
# detached merge, ONE implementation for detached-merge/commit.sh and integrator-5/reprep.sh. w00/identity-check.sh is used unchanged.
#   (a) package mode only: identity-check.sh commits over FORK..HEADSHA, FORK = git merge-base BASE HEADSHA (author and committer of the
#       branch's own commits; the content part of that mode reads only files the branch itself changed). The record names FORK.
#   (b) both modes: identity-check.sh files over the merge's STAGED files: git diff --name-only --diff-filter=d BASE TREE (deletions
#       excluded), the blobs taken from TREE (git show TREE:path) into a run-scoped temp dir, removed before return. This is the gate for
#       what lands on integ. The old content check over the BASE..HEADSHA range (it read files the branch never changed) is gone.
#   MODE: IDENTITY_MODE from config.sh; unset = package; anything other than package or sync is refused by name.
#   MAIN-OWN (team-lead 2026-10-17; sync mode ONLY): a staged-files finding file:line whose line is byte-identical to a line of
#   HEADSHA:file (main's own file) is listed as "MAIN-OWN file:line" in <prefix>identity-staged-main-own.txt and does not refuse; a flagged
#   line absent from main's own file refuses. Package mode never applies it. The line text is compared in memory, never printed, and
#   never placed in a child process argv (validator-8 M2: a bash comparison, line by line). It applies ONLY to a well-formed FINDINGS
#   record (validator-8 M1): the last line is "identity-check files: N file(s), FINDINGS", at least one finding line parses, and the
#   parsed count equals the count of "IDENTITY:" lines; any other failure of the checker keeps the refusal (no fail-open).
# Records ONLY under <dir>, prefixed by <prefix> (prep- or commit-): <prefix>identity-base.txt, <prefix>identity-commits.txt (package),
# <prefix>identity-staged-list.txt, <prefix>identity-staged.txt. Prints one summary line; returns 0 clean, 1 finding, 2 usage.
MERGE_IDENTITY_CHECK=${MERGE_IDENTITY_CHECK:-evidence/w00/identity-check.sh}
merge_identity_commits() {   # <dir> <prefix> <base> <headsha> <repo>
  local D=$1 P=$2 B=$3 H=$4 R=$5 F
  F=$(git -C "$R" merge-base "$B" "$H") || { echo "merge-identity: no merge-base of ${B:0:9} and ${H:0:9}" | tee "$D/${P}identity-base.txt"; return 1; }
  echo "identity fork point: $F = git merge-base ${B:0:9} ${H:0:9}" > "$D/${P}identity-base.txt"
  IDENTITY_REPO=$R bash "$MERGE_IDENTITY_CHECK" commits "$F" "$H" > "$D/${P}identity-commits.txt" 2>&1
}
merge_identity_staged() {    # <dir> <prefix> <base> <tree> <repo> [<mode> <headsha>]
  local D=$1 P=$2 B=$3 T=$4 R=$5 M=${6:-package} H=${7:-} tmp st=0 f l txt x found rec parsed total
  git -C "$R" diff --name-only --diff-filter=d "$B" "$T" > "$D/${P}identity-staged-list.txt" || { echo "merge-identity: cannot list ${B:0:9}..${T:0:9}"; return 1; }
  tmp=$(mktemp -d /tmp/merge-identity.XXXXXX) || return 1
  while IFS= read -r f; do mkdir -p "$tmp/$(dirname "$f")"; git -C "$R" show "$T:$f" > "$tmp/$f" || st=1; done < "$D/${P}identity-staged-list.txt"
  if [ $st = 0 ]; then ( cd "$tmp" && mapfile -t L < "$D/${P}identity-staged-list.txt" && bash "$MERGE_IDENTITY_CHECK" files "${L[@]}" ) > "$D/${P}identity-staged.txt" 2>&1 || st=1
  else echo "merge-identity: a staged blob could not be read from ${T:0:9}" > "$D/${P}identity-staged.txt"; fi
  rm -rf "$tmp"
  rec="$D/${P}identity-staged.txt"
  if [ $st = 1 ] && [ "$M" = sync ] && [ -n "$H" ] && ! grep -q '^merge-identity:' "$rec"; then
    parsed=$(sed -n 's/^IDENTITY: \(.*\):\([0-9][0-9]*\) holds .*/\1:\2/p' "$rec" | grep -c .); total=$(grep -c '^IDENTITY:' "$rec")
    if [[ "$(tail -1 "$rec")" =~ ^identity-check\ files:\ [0-9]+\ file\(s\),\ FINDINGS$ ]] && [ "$parsed" -ge 1 ] && [ "$parsed" = "$total" ]; then
      st=0; : > "$D/${P}identity-staged-main-own.txt"
      while IFS=: read -r f l; do
        txt=$(git -C "$R" show "$T:$f" | sed -n "${l}p"); found=0
        while IFS= read -r x; do [ "$x" = "$txt" ] && { found=1; break; }; done < <(git -C "$R" show "$H:$f" 2>/dev/null)
        if [ $found = 1 ]; then echo "MAIN-OWN $f:$l" >> "$D/${P}identity-staged-main-own.txt"; else st=1; fi
      done < <(sed -n 's/^IDENTITY: \(.*\):\([0-9][0-9]*\) holds .*/\1:\2/p' "$rec")
    fi
  fi
  return $st
}
merge_identity() {           # <dir> <prefix> <base> <headsha> <tree> <mode> <repo>
  local D=$1 P=$2 B=$3 H=$4 T=$5 M=${6:-package} R=$7 a=0 b=0
  case "$M" in package|sync) ;; *) echo "merge-identity: REFUSED: IDENTITY_MODE '$M' is neither package nor sync"; return 2;; esac
  if [ "$M" = package ]; then merge_identity_commits "$D" "$P" "$B" "$H" "$R" || a=1; fi
  merge_identity_staged "$D" "$P" "$B" "$T" "$R" "$M" "$H" || b=1
  echo "merge-identity ($M): commits $( [ "$M" = package ] && { [ $a = 0 ] && echo clean || echo FINDINGS; } || echo 'not checked (sync)'), staged files $( [ $b = 0 ] && echo clean || echo FINDINGS)$( [ -s "$D/${P}identity-staged-main-own.txt" ] && echo "; MAIN-OWN lines (sync, informational): $(grep -c . "$D/${P}identity-staged-main-own.txt")")"
  [ $a = 0 ] && [ $b = 0 ]
}
