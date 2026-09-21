#!/usr/bin/env bash
# Report whether files Docker can send from this checkout differ from HEAD.
# Git ignore rules are intentionally irrelevant: Docker's build context is
# controlled only by its active .dockerignore file.
set -uo pipefail

MODE=source-state
if [ "${1:-}" = "--revision" ]; then
  MODE=revision
  shift
fi
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Run every provenance Git query behind one clean boundary. Hooks, parent Git
# commands, and the dev container itself export GIT_* variables; none may point
# this audit at another repository/index or alter Docker-ignore matching.
# System/global config is diagnostic-host state, while the selected checkout's
# local config is retained so linked worktrees continue to resolve correctly.
sanitized_git() {
  env -i \
    PATH="${PATH:-/usr/bin:/bin}" \
    HOME="${HOME:-/nonexistent}" \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_OPTIONAL_LOCKS=0 \
    git -c safe.directory="$REPO_ROOT" "$@"
}

# Docker matching is case-sensitive on every host. Git commonly records
# core.ignoreCase=true on macOS; force Docker's rule for source-state queries.
source_state_git() {
  sanitized_git \
    -c core.ignoreCase=false \
    -c core.fileMode=true \
    -c core.fsmonitor=false \
    -c core.ignoreStat=false \
    -c core.excludesFile=/dev/null \
    "$@"
}

unknown() {
  echo unknown
  exit 0
}

cd "$REPO_ROOT" 2>/dev/null || unknown
sanitized_git rev-parse --is-inside-work-tree >/dev/null 2>&1 || unknown

if [ "$MODE" = revision ]; then
  sanitized_git rev-parse --verify HEAD 2>/dev/null || unknown
  exit 0
fi

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
HIDDEN_INDEX=""
MATCHER_ROOT=""
cleanup() {
  rm -f "$CANDIDATES"
  [ -z "$HIDDEN_INDEX" ] || rm -f "$HIDDEN_INDEX"
  [ -z "$MATCHER_ROOT" ] || rm -rf "$MATCHER_ROOT"
}
trap cleanup EXIT HUP INT TERM
HIDDEN_INDEX="$(mktemp "${TMPDIR:-/tmp}/ezcorp-dev-image-hidden-index.XXXXXX")" || unknown

# Keep Git ignore rules out of this enumeration. Docker can send an untracked
# file even when a developer's .gitignore or .git/info/exclude hides it.
if ! {
  # Keep both sides of renames: moving an included file under an exclusion still
  # removes an input from the image.
  source_state_git diff --name-only -z --no-ext-diff --no-renames --ignore-submodules=none HEAD --
  source_state_git ls-files --others -z "${DOCKER_EXCLUDE_ARGS[@]}" --
  # Git normally omits empty untracked directories. Docker sends them, and
  # COPY preserves them, so include untracked directory entries explicitly.
  source_state_git ls-files --others --directory -z "${DOCKER_EXCLUDE_ARGS[@]}" --
  source_state_git ls-files --others -z -- Dockerfile.dev "$DOCKERIGNORE_RELATIVE"
} >"$CANDIDATES" 2>/dev/null; then
  unknown
fi

# Assume-unchanged and skip-worktree are performance hints, not statements
# about Docker's context. Git diff deliberately trusts them, so inspect those
# tracked paths separately before accepting a clean result. `ls-files -v`
# prints assume-unchanged entries with a lowercase status and skip-worktree
# entries as S (or lowercase s when both flags are present).
if ! source_state_git ls-files -v -z -- |
  while IFS= read -r -d '' entry; do
    marker="${entry:0:1}"
    case "$marker" in
      S | [a-z]) printf '%s\0' "${entry:2}" ;;
    esac
  done >"$HIDDEN_INDEX"; then
  unknown
fi

[ -s "$CANDIDATES" ] || [ -s "$HIDDEN_INDEX" ] || { echo clean; exit 0; }

# `git ls-files --exclude` applies exclusions only to untracked files. Put the
# same translated rules in a private empty repository so
# `check-ignore --no-index` can apply them to tracked changes and deletions too.
# This keeps one ordered matcher for every candidate and does not read the
# project's Git ignore files.
MATCHER_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ezcorp-dockerignore.XXXXXX")" || unknown
sanitized_git -C "$MATCHER_ROOT" init -q >/dev/null 2>&1 || unknown
printf '%s\n' "$DOCKER_EXCLUDES" >"$MATCHER_ROOT/.git/info/exclude" || unknown

docker_context_includes() {
  local path="$1" match_status
  # Docker always sends the selected Dockerfile and ignore file to the builder,
  # even if an ignore pattern names them.
  if [ "$path" = "Dockerfile.dev" ] || [ "$path" = ".dockerignore" ] \
    || [ "$path" = "Dockerfile.dev.dockerignore" ] || [ "$path" = "$DOCKERIGNORE_RELATIVE" ]; then
    return 0
  fi

  source_state_git -C "$MATCHER_ROOT" check-ignore -q --no-index -- "$path" 2>/dev/null
  match_status=$?
  case "$match_status" in
    0) return 1 ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
}

# Return 0 when an index-hidden tracked path differs from HEAD, 1 when its raw
# bytes and executable mode match, and 2 when the comparison is unavailable.
# Unsupported tracked entry types are conservatively dirty: Docker sends their
# filesystem representation, which a regular-file comparison cannot prove.
hidden_path_differs_from_head() {
  local path="$1" tree_entry remainder mode type object worktree_object
  tree_entry="$(source_state_git --literal-pathspecs ls-tree HEAD -- "$path" 2>/dev/null)" || return 2
  [ -n "$tree_entry" ] || return 0
  mode="${tree_entry%% *}"
  remainder="${tree_entry#* }"
  type="${remainder%% *}"
  remainder="${remainder#* }"
  object="${remainder%%$'\t'*}"

  [ "$type" = blob ] || return 0
  [ -f "$path" ] && [ ! -L "$path" ] || return 0
  case "$mode" in
    100644) [ ! -x "$path" ] || return 0 ;;
    100755) [ -x "$path" ] || return 0 ;;
    *) return 0 ;;
  esac
  worktree_object="$(source_state_git hash-object --no-filters -- "$path" 2>/dev/null)" || return 2
  [ "$worktree_object" = "$object" ] && return 1
  return 0
}

while IFS= read -r -d '' path; do
  docker_context_includes "$path"
  MATCH_STATUS=$?
  if [ "$MATCH_STATUS" = 0 ]; then
    echo dirty
    exit 0
  elif [ "$MATCH_STATUS" != 1 ]; then
    unknown
  fi
done <"$CANDIDATES"

while IFS= read -r -d '' path; do
  docker_context_includes "$path"
  MATCH_STATUS=$?
  [ "$MATCH_STATUS" = 1 ] && continue
  [ "$MATCH_STATUS" = 0 ] || unknown

  hidden_path_differs_from_head "$path"
  HIDDEN_STATUS=$?
  if [ "$HIDDEN_STATUS" = 0 ]; then
    echo dirty
    exit 0
  elif [ "$HIDDEN_STATUS" != 1 ]; then
    unknown
  fi
done <"$HIDDEN_INDEX"

echo clean
