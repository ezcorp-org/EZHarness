# s11-lib.sh (sourced by bin/locked-s11r.sh): the session-11 helpers, one copy (the spent bin/locked-s11.sh keeps its own as a record).
# The caller sets E, W, D, S, P (patch folder), BUN and MUTANT_DOCKERFILE_REV, and cds into W.
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$S"; }
# leg <name> <cmd...>: output to $D/<name>.log; START and END (with the exit) in legs.log; returns the exit.
leg() { local n=$1 rc; shift; say "START $n"; "$@" > "$D/$n.log" 2>&1; rc=$?; say "END $n exit=$rc"; return $rc; }
manifest() { (cd "$D" && find . \( -path ./tree-a27 -o -path ./tree-new -o -name test-results \) -prune -o -type f ! -name s11-shas.txt -print0 | sort -z | xargs -0 sha256sum) > "$D/s11-shas.txt"; }
# No builder image here (team-lead: ONE copy; the image legs ran in session 11 v4 and passed).
finish() { say "final exit $1: head $(git -C "$W" log -1 --format='%h %s'), porcelain $(git -C "$W" status --porcelain | wc -l)"; manifest; exit "$1"; }
# commit_fix <nn> <msg> <paths...>: the patch is applied already; the commit through the hook; a refused commit is unstaged and reverted.
commit_fix() { local nn=$1 msg=$2 parent rc; shift 2; parent=$(git rev-parse --short HEAD)
  leg "commit-$nn" bash "$E/bin/locked-commit-fix.sh" "$msg" "$parent" "$@"; rc=$?
  say "after commit $nn: $(git log -1 --format='%h %s')"
  if [ "$rc" != 0 ] && [ "$(git rev-parse --short HEAD)" = "$parent" ]; then git reset -q && git apply -R "$P/$nn.patch"; say "commit $nn not made: patch reverted, porcelain $(git status --porcelain | wc -l)"; fi
  return $rc; }
apply() { git apply "$P/$1.patch" || { say "STOP: $1.patch does not apply at $(git rev-parse --short HEAD)"; finish 1; }; }
# r3_run <name> <tree> -> sets r3rc, red, green from r3-github-repeat.sh (20 repeats; exit 3 = NOT RUN, by name), and leak=1 when the
# owner worktree's web/node_modules/.vite-temp gained an entry during the run (validator-8: the webServer must never write there).
vite_temp() { find "$W/web/node_modules/.vite-temp" -mindepth 1 2>/dev/null | sort; }
r3_run() { local before after; before=$(vite_temp); leg "$1" bash "$E/bin/r3-github-repeat.sh" "$2" "$D/$1" 20; r3rc=$?
  after=$(vite_temp); if [ "$before" != "$after" ]; then leak=1; say "LEAK: $1 wrote into the owner worktree's web/node_modules/.vite-temp: $(comm -13 <(echo "$before") <(echo "$after") | tr '\n' ' ')"; else say "$1: no new .vite-temp entry in the owner worktree"; fi
  read -r red green <<< "$(sed -nE 's/^r3: exit [0-9]+; ([0-9]+) red of :208, ([0-9]+) green of :208$/\1 \2/p' "$D/$1/playwright.log" 2>/dev/null | tail -1)"
  say "R3 $1: runner exit $r3rc, red ${red:-?} green ${green:-?} of 20"; }
# mutant <nn> <file> <old-dockerfile | sed expression> <test files...>: must turn its tests red; the file is restored from HEAD after.
mutant() { local n=$1 file=$2 how=$3; shift 3; say "mutant $n: $how"
  case $how in old-dockerfile) git show "$MUTANT_DOCKERFILE_REV:$file" > "$file" ;; *) sed -i "$how" "$file" ;; esac
  git diff --quiet -- "$file" && { say "mutant $n NOT PLANTED (no change)"; mut=1; return; }
  leg "mutant-$n" "$BUN" test "$@"; [ $? != 0 ] || { say "mutant $n NOT KILLED"; mut=1; }
  git checkout -q -- "$file"; }
