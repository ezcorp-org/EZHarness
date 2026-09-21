#!/usr/bin/env bash
# Report whether files Docker can send from this checkout differ from HEAD.
# Git ignore rules are intentionally irrelevant: Docker's build context is
# controlled only by its active .dockerignore file.
set -uo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

unknown() {
  echo unknown
  exit 0
}

cd "$REPO_ROOT" 2>/dev/null || unknown
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || unknown

# Docker anchors a bare name at the context root, while Git's exclude matcher
# applies it at every depth. Leading and trailing slashes are insignificant to
# Docker. Normalize those differences, then retain ordered wildcard and
# negation handling through Git's matcher.
dockerignore_as_git_excludes() {
  [ -f "$REPO_ROOT/.dockerignore" ] || return 0
  awk '
    /^#/ { next }
    {
      pattern = $0
      sub(/^[[:space:]]+/, "", pattern)
      sub(/[[:space:]]+$/, "", pattern)
      if (pattern == "") next
      negate = ""
      if (substr(pattern, 1, 1) == "!") {
        negate = "!"
        pattern = substr(pattern, 2)
      }
      sub(/^\/+/, "", pattern)
      sub(/\/+$/, "", pattern)
      if (index(pattern, "/") == 0) pattern = "/" pattern
      print negate pattern
    }
  ' "$REPO_ROOT/.dockerignore"
}

if ! DOCKER_EXCLUDES="$(dockerignore_as_git_excludes 2>/dev/null)"; then
  unknown
fi

DOCKER_EXCLUDE_ARGS=()
while IFS= read -r pattern; do
  [ -n "$pattern" ] && DOCKER_EXCLUDE_ARGS+=("--exclude=$pattern")
done <<<"$DOCKER_EXCLUDES"

if git diff --quiet --no-ext-diff HEAD -- 2>/dev/null; then
  if ! UNTRACKED_BUILD_INPUTS="$(git ls-files --others "${DOCKER_EXCLUDE_ARGS[@]}" -- 2>/dev/null)"; then
    unknown
  elif [ -n "$UNTRACKED_BUILD_INPUTS" ]; then
    echo dirty
  else
    echo clean
  fi
else
  GIT_DIFF_STATUS=$?
  if [ "$GIT_DIFF_STATUS" = 1 ]; then
    echo dirty
  else
    unknown
  fi
fi
