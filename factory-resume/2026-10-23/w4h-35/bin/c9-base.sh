# c9-base.sh (sourced): c9_base_check <repo> <base> <log>: true only when `git merge-base HEAD origin/main` in <repo> is <base>
# (F1, team-lead 2026-10-20: the fast and C9 base is the branch's merge-base with main, not the merge's first parent); otherwise it
# names the refusal in the log and returns 3, so no stage runs against a base that main has moved past.
c9_base_check() {
  local repo=$1 want=$2 log=$3 got
  got=$(git -C "$repo" merge-base HEAD origin/main 2> /dev/null)
  [ -n "$got" ] && [ "$got" = "$(git -C "$repo" rev-parse -q --verify "$want^{commit}" 2> /dev/null)" ] && return 0
  echo "STOP: c9 base: merge-base(HEAD, origin/main) is ${got:-none}, not $want; no stage runs" >> "$log"
  return 3
}
