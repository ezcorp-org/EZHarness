#!/usr/bin/env bash
# Report whether files Docker can send from this checkout differ from HEAD.
# Git ignore rules are intentionally irrelevant: Docker's build context is
# controlled only by its active .dockerignore file.
set -uo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Hooks and parent Git commands can export an alternate index or repository.
# Provenance always describes REPO_ROOT's real checkout, and the private
# Docker-ignore matcher below must use its own repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

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
  [ -f "$DOCKERIGNORE" ] || return 0
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
  ' "$DOCKERIGNORE"
}

# A Dockerfile-specific ignore file takes precedence over the root file.
DOCKERIGNORE="$REPO_ROOT/Dockerfile.dev.dockerignore"
if [ ! -f "$DOCKERIGNORE" ]; then
  DOCKERIGNORE="$REPO_ROOT/.dockerignore"
fi
DOCKERIGNORE_RELATIVE="${DOCKERIGNORE#"$REPO_ROOT"/}"

if ! DOCKER_EXCLUDES="$(dockerignore_as_git_excludes 2>/dev/null)"; then
  unknown
fi

DOCKER_EXCLUDE_ARGS=()
while IFS= read -r pattern; do
  [ -n "$pattern" ] && DOCKER_EXCLUDE_ARGS+=("--exclude=$pattern")
done <<<"$DOCKER_EXCLUDES"

CANDIDATES="$(mktemp "${TMPDIR:-/tmp}/ezcorp-dev-image-inputs.XXXXXX")" || unknown
MATCHER_ROOT=""
cleanup() {
  rm -f "$CANDIDATES"
  [ -z "$MATCHER_ROOT" ] || rm -rf "$MATCHER_ROOT"
}
trap cleanup EXIT HUP INT TERM

# Keep Git ignore rules out of this enumeration. Docker can send an untracked
# file even when a developer's .gitignore or .git/info/exclude hides it.
if ! {
  # Keep both sides of renames: moving an included file under an exclusion still
  # removes an input from the image.
  git diff --name-only -z --no-ext-diff --no-renames HEAD --
  git ls-files --others -z "${DOCKER_EXCLUDE_ARGS[@]}" --
  git ls-files --others -z -- Dockerfile.dev "$DOCKERIGNORE_RELATIVE"
} >"$CANDIDATES" 2>/dev/null; then
  unknown
fi

[ -s "$CANDIDATES" ] || { echo clean; exit 0; }

# `git ls-files --exclude` applies exclusions only to untracked files. Put the
# same translated rules in a private empty repository so
# `check-ignore --no-index` can apply them to tracked changes and deletions too.
# This keeps one ordered matcher for every candidate and does not read the
# project's Git ignore files.
MATCHER_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ezcorp-dockerignore.XXXXXX")" || unknown
git -C "$MATCHER_ROOT" init -q >/dev/null 2>&1 || unknown
printf '%s\n' "$DOCKER_EXCLUDES" >"$MATCHER_ROOT/.git/info/exclude" || unknown

while IFS= read -r -d '' path; do
  # Docker always sends the selected Dockerfile and ignore file to the builder,
  # even if an ignore pattern names them.
  if [ "$path" = "Dockerfile.dev" ] || [ "$path" = ".dockerignore" ] \
    || [ "$path" = "Dockerfile.dev.dockerignore" ] || [ "$path" = "$DOCKERIGNORE_RELATIVE" ]; then
    echo dirty
    exit 0
  fi

  git -C "$MATCHER_ROOT" check-ignore -q --no-index -- "$path" 2>/dev/null
  MATCH_STATUS=$?
  if [ "$MATCH_STATUS" = 1 ]; then
    echo dirty
    exit 0
  elif [ "$MATCH_STATUS" != 0 ]; then
    unknown
  fi
done <"$CANDIDATES"

echo clean
