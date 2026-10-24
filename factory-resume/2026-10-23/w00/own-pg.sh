# own-pg.sh (sourced; integrator-4, lead's W4H-12 order 2026-10-06): a FRESH PostgreSQL of the job's service image for one hold or
# one commit, never the shared proof server. own_pg_start <name>: removes any old container of that name (with -v), starts
# docker.io/pgvector/pgvector:pg15 on 127.0.0.1 with a random password in a 0700 home under /tmp (outside the evidence dir), waits for
# pg_isready, exports PG_ENV_FILE and PG_CONTAINER (heavy-lib.sh pg() and detached-merge/commit.sh read them) and sets an EXIT trap
# that removes the container with its anonymous volumes and the home. The image is public (not ours): never removed. No secret printed.
# Digest pin (team-lead ruling 2026-10-16 (b)): the image comes from OWN_PG_LOCK (default w00/test-images.lock.json, the repo's
# scripts/test-images.json shape, key "pgvector": a linux/amd64 platform-manifest digest, the same form as the repo's "postgres" entry);
# anything not "<name>@sha256:<64 hex>" (a tag, a short digest, a missing key or file) is refused before podman runs. W4H-33 adds the key
# to the repo file; then this reads the merge's tree and the w00 file is a fallback only.
own_pg_start() {
  OWN_PG_NAME=${1:?name}; OWN_PG_HOME=/tmp/$OWN_PG_NAME-home; local img i
  img=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["pgvector"])' "${OWN_PG_LOCK:-evidence/w00/test-images.lock.json}" 2>/dev/null)
  [[ "$img" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || { echo "own-pg: STOP: image ${img:-<none>} is not pinned by digest (lock ${OWN_PG_LOCK:-w00/test-images.lock.json})"; return 3; }
  own_pg_stop() { podman rm -f -v "$OWN_PG_NAME" > /dev/null 2>&1; rm -rf "$OWN_PG_HOME"; }
  trap own_pg_stop EXIT
  own_pg_stop; mkdir -m 0700 "$OWN_PG_HOME"
  ( umask 077; printf 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=<REDACTED> "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" > "$OWN_PG_HOME/pg.env" )
  podman image exists "$img" || podman pull -q "$img" > /dev/null || { echo "own-pg: STOP: no $img"; return 3; }
  # OWN_PG_NETWORK (team-lead 2026-10-16, W4H-35 run 3: rootless Podman cannot attach a bridge network to a pasta-mode container after start):
  # when set, the server joins that network FROM THE START (and keeps its 127.0.0.1 port); unset, the run line is unchanged.
  podman run -d --name "$OWN_PG_NAME" --env-file "$OWN_PG_HOME/pg.env" ${OWN_PG_NETWORK:+--network "$OWN_PG_NETWORK"} -p 127.0.0.1::5432 $img > /dev/null || { echo "own-pg: STOP: start"; return 3; }
  # Readiness (W4H-34 hold attempt 2, 2026-10-17Z22:45: the image's first-start init server answers on the Unix socket, then restarts, so a
  # socket check could pass and the next one fail; team-lead's ruling e5deabfca19cd175): every check is over TCP inside the container (the
  # init server does not listen on TCP) and THREE consecutive passes 1 s apart are needed, within the same 60-check bound.
  local ok=0
  for i in $(seq 1 60); do
    if podman exec "$OWN_PG_NAME" pg_isready -h 127.0.0.1 -U postgres -d ezcorp_test > /dev/null 2>&1; then ok=$((ok + 1)); [ "$ok" -ge 3 ] && break; else ok=0; fi
    sleep 1
  done
  [ "$ok" -ge 3 ] || { echo "own-pg: STOP: not ready"; return 3; }
  export PG_ENV_FILE=$OWN_PG_HOME/pg.env PG_CONTAINER=$OWN_PG_NAME
  echo "own-pg: $OWN_PG_NAME ($img $(podman image inspect $img --format '{{.Id}}' | cut -c1-12), server $(podman exec "$OWN_PG_NAME" postgres --version | awk '{print $3}')) on 127.0.0.1:$(podman port "$OWN_PG_NAME" 5432 | head -1 | sed 's/.*://')"
}
