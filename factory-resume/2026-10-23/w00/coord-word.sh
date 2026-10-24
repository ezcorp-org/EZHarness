# w00/coord-word.sh (integrator-5, 2026-10-17; TEAM RULE from team-lead after W4H-35 launched twice without a word): every lock launcher
# takes COORD_WORD=<the coordinator word's message id>, writes it as the FIRST line of its launch log, and refuses by name without it.
# One function for every launcher (source this file; call it FIRST in each lock branch, before any mv, exit-file or lock step):
# coord_word <launch-log> <label>: 4 = refused, nothing written: COORD_WORD unset, or not a message id (hex, 8 to 36 characters, dashes
# allowed), or <launch-log> already exists (a re-launch renames the old log by mv first, with its hash reported before the move; so the
# word line is always the first line). 0 = wrote "COORD_WORD=<id> <label> <UTC>" as the new log's first line.
coord_word() {
  local id=${COORD_WORD:-}
  [ -n "$id" ] || { echo "REFUSED: COORD_WORD is unset: no coordinator word id for $2"; return 4; }
  [[ "$id" =~ ^[0-9a-f][0-9a-f-]{7,35}$ ]] || { echo "REFUSED: COORD_WORD='$id' is not a message id ($2)"; return 4; }
  [ -e "$1" ] && { echo "REFUSED: $1 exists: rename it by mv first, hash reported before the move ($2)"; return 4; }
  echo "COORD_WORD=$id $2 $(date -u +%FT%TZ)" > "$1" || { echo "REFUSED: cannot write $1 ($2)"; return 4; }
  echo "coord-word: $2 on word $id"
}
